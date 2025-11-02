// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.7.6;
pragma abicoder v2;

import "@lpp/lpp-protocol/contracts/interfaces/ILPPFactory.sol";
import "@lpp/lpp-protocol/contracts/interfaces/ILPPPool.sol";
import "@lpp/lpp-protocol/contracts/libraries/TickMath.sol";

import "../libraries/PoolAddress.sol";
import "../libraries/LiquidityAmounts.sol";

import "./PeripheryImmutableState.sol";

/// @dev Minimal interface to the canonical mint hook
interface ILPPMintHook {
    struct MintParams {
        address pool;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        address recipient;
        address payer;
    }

    /// Performs the hooked mint (pulls funds from `payer`, applies rebates/retention, locks, emits events, etc).
    /// Implementations may or may not return amounts; we ignore return data for compatibility.
    function mintWithRebate(MintParams calldata params) external;
}

/// @dev Optional pool interface extension if the pool exposes its canonical hook.
interface ILPPPoolWithMintHook {
    function mintHook() external view returns (address);
}

/// @title Liquidity management (hook-routed)
/// @notice Internal helpers for safely managing liquidity that MUST go through the canonical hook.
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
        address payer;
        address hook;
    }

    /// @notice Add liquidity to an already-created+initialized pool via the canonical hook.
    /// @dev Never calls ILPPPool.mint directly; reverts if the pool is not hook-wired.
    function addLiquidity(AddLiquidityParams memory params)
        internal
        returns (
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1,
            ILPPPool pool
        )
    {
        // Resolve pool
        address poolAddr = ILPPFactory(factory).getPool(params.token0, params.token1, params.fee);
        require(poolAddr != address(0), "LPP: pool not deployed");
        uint256 size; assembly { size := extcodesize(poolAddr) }
        require(size > 0, "LPP: pool code missing");
        pool = ILPPPool(poolAddr);

        // Compute liquidity and implied amounts in a separate frame (avoids stack-too-deep)
        (liquidity, amount0, amount1) = _quoteLiquidity(
            pool,
            params.tickLower,
            params.tickUpper,
            params.amount0Desired,
            params.amount1Desired
        );
        require(amount0 >= params.amount0Min, "Price slippage token0");
        require(amount1 >= params.amount1Min, "Price slippage token1");

        // Call the canonical hook (payer inlined to avoid extra local)
        ILPPMintHook(_resolveHook(poolAddr, params.hook)).mintWithRebate(
            ILPPMintHook.MintParams({
                pool:      poolAddr,
                tickLower: params.tickLower,
                tickUpper: params.tickUpper,
                liquidity: liquidity,
                recipient: params.recipient,
                payer:     (params.payer == address(0) ? msg.sender : params.payer)
            })
        );
        // NOTE: We intentionally do not parse hook events here.
    }

    /// @dev Resolve the canonical mint hook. Never optional.
    function _resolveHook(address poolAddr, address provided) private view returns (address h) {
        if (provided != address(0)) {
            h = provided;
        } else {
            // Try pool.mintHook() if implemented
            (bool ok, bytes memory ret) = poolAddr.staticcall(abi.encodeWithSignature("mintHook()"));
            if (ok && ret.length == 32) {
                h = abi.decode(ret, (address));
            }
        }
        require(h != address(0), "ONLY_HOOKED_POOLS");
    }

    /// @dev Quotes liquidity and implied token amounts at the current pool price.
    ///      Split out to keep addLiquidity under the stack limit for 0.7.x.
    function _quoteLiquidity(
        ILPPPool pool,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0Desired,
        uint256 amount1Desired
    )
        private
        view
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        (uint160 sqrtPriceX96,,,,,,) = pool.slot0();
        uint160 sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(tickUpper);

        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            sqrtRatioAX96,
            sqrtRatioBX96,
            amount0Desired,
            amount1Desired
        );
        require(liquidity > 0, "LPP: liq=0");

        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPriceX96,
            sqrtRatioAX96,
            sqrtRatioBX96,
            liquidity
        );
    }
}