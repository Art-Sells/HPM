// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.7.6;
pragma abicoder v2;

import "@lpp/lpp-protocol/contracts/interfaces/ILPPFactory.sol";
import "@lpp/lpp-protocol/contracts/interfaces/ILPPPool.sol";
import "@lpp/lpp-protocol/contracts/libraries/TickMath.sol";
import "../libraries/PoolAddress.sol";
import "../libraries/LiquidityAmounts.sol";
import "./PeripheryImmutableState.sol";

// Inline interface mirror of the on-chain hook.
// IMPORTANT: outputs match the deployed LPPMintHook (amount0, amount1).
interface ILPPMintHook {
    struct MintParams {
        address pool;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        address recipient;
        address payer;
    }
    function mintWithRebate(MintParams calldata params)
        external
        returns (uint256 amount0, uint256 amount1);
}

abstract contract LiquidityManagement is PeripheryImmutableState {
    struct AddLiquidityParams {
        address token0;
        address token1;
        uint24  fee;
        address recipient;
        int24   tickLower;
        int24   tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address payer;   // who funds both owed legs + surcharge in hook
        address hook;    // optional override; otherwise discovered via pool.mintHook()
    }

    function addLiquidity(AddLiquidityParams memory p)
        internal
        returns (uint128 liquidity, uint256 amount0, uint256 amount1, ILPPPool pool)
    {
        address poolAddr = ILPPFactory(factory).getPool(p.token0, p.token1, p.fee);
        require(poolAddr != address(0), "LPP: pool not deployed");
        uint256 size; assembly { size := extcodesize(poolAddr) }
        require(size > 0, "LPP: pool code missing");
        pool = ILPPPool(poolAddr);

        (uint160 sqrtPriceX96,,,,,,) = pool.slot0();
        uint160 sqrtA = TickMath.getSqrtRatioAtTick(p.tickLower);
        uint160 sqrtB = TickMath.getSqrtRatioAtTick(p.tickUpper);

        // Compute target liquidity from desired token amounts at current price
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, sqrtA, sqrtB, p.amount0Desired, p.amount1Desired
        );
        require(liquidity > 0, "LPP: liq=0");

        // Pre-sanity on min bounds (defensive: these are theoretical pre-mint amounts)
        (uint256 est0, uint256 est1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPriceX96, sqrtA, sqrtB, liquidity
        );
        require(est0 >= p.amount0Min, "slip0");
        require(est1 >= p.amount1Min, "slip1");

        // Execute only through the canonical mint hook (no direct pool.mint fallback)
        (amount0, amount1) = _executeMint(poolAddr, p, liquidity);
    }

    function _executeMint(
        address poolAddr,
        AddLiquidityParams memory p,
        uint128 liquidity
    ) private returns (uint256 amount0, uint256 amount1) {
        address payer = (p.payer == address(0) ? msg.sender : p.payer);

        (address hookAddr, bool ok) = _resolveHookMaybe(poolAddr, p.hook);
        // Enforce hook-only minting; tests also assert pool.mint reverts for non-hook callers
        require(ok && hookAddr != address(0), "ONLY_HOOKED_POOLS");

        (amount0, amount1) = ILPPMintHook(hookAddr).mintWithRebate(
            ILPPMintHook.MintParams({
                pool:      poolAddr,
                tickLower: p.tickLower,
                tickUpper: p.tickUpper,
                liquidity: liquidity,
                recipient: p.recipient,
                payer:     payer
            })
        );
    }

    function _resolveHookMaybe(address poolAddr, address provided)
        private view returns (address h, bool ok)
    {
        // Explicit override provided → must be a contract
        if (provided != address(0)) {
            uint256 s; assembly { s := extcodesize(provided) }
            require(s > 0, "ONLY_HOOKED_POOLS");
            return (provided, true);
        }

        // Discover via optional pool view `mintHook()`
        (bool success, bytes memory ret) = poolAddr.staticcall(abi.encodeWithSignature("mintHook()"));
        if (success && ret.length == 32) {
            address candidate = abi.decode(ret, (address));
            uint256 s; assembly { s := extcodesize(candidate) }
            if (s > 0) return (candidate, true);
        }
        return (address(0), false);
    }
}