// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPMintHook } from "./interfaces/ILPPMintHook.sol";
import { ILPPPool } from "./interfaces/ILPPPool.sol";
import { ILPPTreasury } from "./interfaces/ILPPTreasury.sol";
import { ILPPRebateVault } from "./interfaces/ILPPRebateVault.sol";

import { IERC20, SafeERC20 } from "./external/SafeERC20.sol"; // <── NEW

contract LPPMintHook is ILPPMintHook {
    using SafeERC20 for IERC20;

    ILPPTreasury public immutable treasury;
    ILPPRebateVault public immutable rebateVault;

    constructor(address _treasury, address _rebateVault) {
        treasury = ILPPTreasury(_treasury);
        rebateVault = ILPPRebateVault(_rebateVault);
    }

    /// One-time bootstrap via Treasury → **moves real tokens** into the pool.
    function bootstrap(address pool, uint256 amtA, uint256 amtU, int256 offsetBps) external {
        require(msg.sender == address(treasury), "only treasury");

        address asset = ILPPPool(pool).asset();
        address usdc  = ILPPPool(pool).usdc();

        // Treasury must have approved this hook to pull bootstrap funds
        IERC20(asset).safeTransferFrom(msg.sender, pool, amtA);
        IERC20(usdc ).safeTransferFrom(msg.sender, pool, amtU);

        // Initialize pool (reserves/prices updated inside pool)
        ILPPPool(pool).bootstrapInitialize(amtA, amtU, offsetBps);
    }

    function mintWithRebate(MintParams calldata params)
        external
        override
        returns (uint256 liquidityOut)
    {
        ILPPPool pool = ILPPPool(params.pool);
        uint256 rA = pool.reserveAsset();
        uint256 rU = pool.reserveUsdc();
        require(rA > 0 && rU > 0, "pool not initialized");

        // equal-value within 10 bps
        uint256 usdcNeeded = (params.amountAssetDesired * rU) / rA;
        uint256 tol = (usdcNeeded * 10) / 10_000; // 10 bps
        require(
            params.amountUsdcDesired >= (usdcNeeded > tol ? usdcNeeded - tol : 0) &&
            params.amountUsdcDesired <= usdcNeeded + tol,
            "unequal value"
        );

        // TVL share (bps) using implied price (USDC per 1 asset)
        uint256 price1e18 = (rU * 1e18) / rA;
        uint256 depositValueUsdc = (params.amountAssetDesired * price1e18) / 1e18 + params.amountUsdcDesired;
        uint256 poolTvlUsdc      = (rA * price1e18) / 1e18 + rU;
        uint256 tvlAfter         = poolTvlUsdc + depositValueUsdc;
        uint256 shareBps         = tvlAfter == 0 ? 0 : (depositValueUsdc * 10_000) / tvlAfter;

        // tiers (example — keep whatever you had)
        uint16 rebateBps; uint16 retentionBps; uint8 tier;
        if (shareBps >= 500 && shareBps < 1000)       { tier = 1; rebateBps = 100; retentionBps = 50; }
        else if (shareBps >= 1000 && shareBps < 2000) { tier = 2; rebateBps = 180; retentionBps = 90; }
        else if (shareBps >= 2000 && shareBps < 3500) { tier = 3; rebateBps = 250; retentionBps = 125; }
        else if (shareBps >= 5000)                    { tier = 4; rebateBps = 350; retentionBps = 175; }

        uint16 skimBps = rebateBps + retentionBps;

        // split the deposit
        uint256 amountAssetMint = (params.amountAssetDesired * (10_000 - skimBps)) / 10_000;
        uint256 amountUsdcMint  = (params.amountUsdcDesired  * (10_000 - skimBps)) / 10_000;

        uint256 rebateAsset = (params.amountAssetDesired * rebateBps) / 10_000;
        uint256 rebateUsdc  = (params.amountUsdcDesired  * rebateBps) / 10_000;

        uint256 keepAsset   = (params.amountAssetDesired * retentionBps) / 10_000;
        uint256 keepUsdc    = (params.amountUsdcDesired  * retentionBps) / 10_000;

        address asset = pool.asset();
        address usdc  = pool.usdc();

        // **MOVE TOKENS** from caller → pool / vault / treasury
        // Caller must approve this hook for (asset + usdc) totals
        if (amountAssetMint  > 0) IERC20(asset).safeTransferFrom(msg.sender, address(pool), amountAssetMint);
        if (amountUsdcMint   > 0) IERC20(usdc ).safeTransferFrom(msg.sender, address(pool), amountUsdcMint);

        if (rebateAsset      > 0) IERC20(asset).safeTransferFrom(msg.sender, address(rebateVault), rebateAsset);
        if (rebateUsdc       > 0) IERC20(usdc ).safeTransferFrom(msg.sender, address(rebateVault), rebateUsdc);

        address assetReceiver = treasury.assetRetentionReceiver();
        address usdcReceiver  = treasury.usdcRetentionReceiver();
        if (keepAsset        > 0) IERC20(asset).safeTransferFrom(msg.sender, assetReceiver, keepAsset);
        if (keepUsdc         > 0) IERC20(usdc ).safeTransferFrom(msg.sender, usdcReceiver,  keepUsdc);

        // Mint LP (pool updates reserves/LP)
        liquidityOut = pool.mintFromHook(params.to, amountAssetMint, amountUsdcMint);

        // keep your accounting event
        if (rebateAsset > 0) emit MCVRebatePaid(params.to, params.pool, asset, rebateAsset, tier);
        if (rebateUsdc  > 0) emit MCVRebatePaid(params.to, params.pool, usdc,  rebateUsdc,  tier);

        emit MCVQualified(params.to, params.pool, tier, shareBps);
    }
}