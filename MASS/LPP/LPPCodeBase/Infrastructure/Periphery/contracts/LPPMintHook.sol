// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.7.6;
pragma abicoder v2;

import '@lpp/lpp-protocol/contracts/interfaces/ILPPPool.sol';
import '@lpp/lpp-protocol/contracts/libraries/TickMath.sol';
import './libraries/LiquidityAmounts.sol';

import './interfaces/IHookEntrypoints.sol';
import './interfaces/IHookMint.sol';

contract LPPMintHook is IHookMint {
    // pool -> manager (position manager) are packed in callback data

    /// @notice Pool calls this during mint; we relay payment to the manager so it can pull from the payer.
    function lppMintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external {
        (address pool, address manager) = abi.decode(data, (address, address));
        require(msg.sender == pool, "BAD_POOL");

        address t0 = ILPPPool(pool).token0();
        address t1 = ILPPPool(pool).token1();

        if (amount0Owed > 0) IHookEntrypoints(manager).hookPay(pool, t0, amount0Owed);
        if (amount1Owed > 0) IHookEntrypoints(manager).hookPay(pool, t1, amount1Owed);
    }

    function mintViaHook(MintViaHookParams calldata p) external override {
        address manager = msg.sender; // the position manager called us

        // Compute liquidity from desired amounts and current price
        (uint160 sqrtPriceX96, , , , , , ) = ILPPPool(p.pool).slot0();
        uint160 sqrtA = TickMath.getSqrtRatioAtTick(p.tickLower);
        uint160 sqrtB = TickMath.getSqrtRatioAtTick(p.tickUpper);

        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            sqrtA,
            sqrtB,
            p.amount0Desired,
            p.amount1Desired
        );
        require(liq > 0, "LIQ=0");

        // hook-gated pool.mint. Owner MUST be the manager (so the manager's PositionKey accrues)
        (uint256 a0, uint256 a1) = ILPPPool(p.pool).mint(
            manager,
            p.tickLower,
            p.tickUpper,
            liq,
            // pass (pool, manager) so our callback can call manager.hookPay(...)
            abi.encode(p.pool, manager)
        );

        // Apply rebates/retention per your existing logic (emits Qualified/RebatePaid/Retained)
        _applyRebatesAndRetention(p.pool, p.payer, a0, a1 /* + tier context */);

        // Hand control back to the manager to mint the NFT + snapshot fee growth
        IHookEntrypoints(manager).finalizeMintFromHook(
            p.pool,
            p.recipient,
            p.tickLower,
            p.tickUpper,
            liq,
            a0,
            a1
        );
    }

    function increaseViaHook(IncreaseViaHookParams calldata p) external override {
        address manager = msg.sender;

        // Compute liquidity to add for the increase
        (uint160 sqrtPriceX96, , , , , , ) = ILPPPool(p.pool).slot0();
        uint160 sqrtA = TickMath.getSqrtRatioAtTick(p.tickLower);
        uint160 sqrtB = TickMath.getSqrtRatioAtTick(p.tickUpper);

        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            sqrtA,
            sqrtB,
            p.amount0Desired,
            p.amount1Desired
        );
        require(liq > 0, "LIQ=0");

        (uint256 a0, uint256 a1) = ILPPPool(p.pool).mint(
            manager,
            p.tickLower,
            p.tickUpper,
            liq,
            abi.encode(p.pool, manager)
        );

        _applyRebatesAndRetention(p.pool, p.payer, a0, a1 /* + tier context */);

        IHookEntrypoints(manager).finalizeIncreaseFromHook(
            p.pool,
            p.tokenId,
            p.tickLower,
            p.tickUpper,
            liq,
            a0,
            a1
        );
    }

    function _applyRebatesAndRetention(
        address /*pool*/,
        address /*payer*/,
        uint256 /*amount0*/,
        uint256 /*amount1*/
    ) internal {
        // your existing surcharge -> split to vault/treasury; emits Qualified/RebatePaid/Retained
    }
}