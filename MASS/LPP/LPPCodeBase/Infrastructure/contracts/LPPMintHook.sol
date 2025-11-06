// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPMintHook } from "./interfaces/ILPPMintHook.sol";
import { ILPPPool } from "./interfaces/ILPPPool.sol";
import { ILPPTreasury } from "./interfaces/ILPPTreasury.sol";
import { ILPPRebateVault } from "./interfaces/ILPPRebateVault.sol";

contract LPPMintHook is ILPPMintHook {
    ILPPTreasury public immutable treasury;
    ILPPRebateVault public immutable rebateVault;

    constructor(address _treasury, address _rebateVault) {
        treasury = ILPPTreasury(_treasury);
        rebateVault = ILPPRebateVault(_rebateVault);
    }

    function mintWithRebate(MintParams calldata params) external override returns (uint256 liquidityOut) {
        ILPPPool pool = ILPPPool(params.pool);
        uint256 rA = pool.reserveAsset();
        uint256 rU = pool.reserveUsdc();
        require(rA > 0 && rU > 0, "pool not initialized");

        uint256 usdcNeeded = (params.amountAssetDesired * rU) / rA;
        uint256 tol = (usdcNeeded * 10) / 10_000; // 10 bps = 0.10%
        require(
            params.amountUsdcDesired >= (usdcNeeded > tol ? usdcNeeded - tol : 0) &&
            params.amountUsdcDesired <= usdcNeeded + tol,
            "unequal value"
        );

        // --- Compute TVL share S (bps) using implied price (USDC per 1 asset) ---
// price = rU / rA (in 1e18 fixed-point)
uint256 price1e18 = (rU * 1e18) / rA;
uint256 depositValueUsdc = (params.amountAssetDesired * price1e18) / 1e18 + params.amountUsdcDesired;
uint256 poolTvlUsdc = (rA * price1e18) / 1e18 + rU;
uint256 tvlAfter = poolTvlUsdc + depositValueUsdc;
uint256 shareBps = tvlAfter > 0 ? (depositValueUsdc * 10_000) / tvlAfter : 0;

// --- Tier selection (bps thresholds) ---
uint16 rebateBps = 0;
uint16 retentionBps = 0;
uint8 tier = 0;
if (shareBps >= 500 && shareBps < 1000) { tier = 1; rebateBps = 100; retentionBps = 50; }
else if (shareBps >= 1000 && shareBps < 2000) { tier = 2; rebateBps = 180; retentionBps = 90; }
else if (shareBps >= 2000 && shareBps < 3500) { tier = 3; rebateBps = 250; retentionBps = 125; }
else if (shareBps >= 5000) { tier = 4; rebateBps = 350; retentionBps = 175; }

uint16 skimBps = rebateBps + retentionBps;

// --- In-kind skim ---
uint256 amountAssetMint = (params.amountAssetDesired * (10_000 - skimBps)) / 10_000;
uint256 amountUsdcMint  = (params.amountUsdcDesired  * (10_000 - skimBps)) / 10_000;

uint256 rebateAsset = (params.amountAssetDesired * rebateBps) / 10_000;
uint256 rebateUsdc  = (params.amountUsdcDesired  * rebateBps) / 10_000;

uint256 keepAsset   = (params.amountAssetDesired * retentionBps) / 10_000;
uint256 keepUsdc    = (params.amountUsdcDesired  * retentionBps) / 10_000;

// --- Mint with remainder ---
liquidityOut = pool.mint(params.to, amountAssetMint, amountUsdcMint);

// --- Pay rebates (record) ---
address assetToken = pool.asset();
address usdcToken  = pool.usdc();
if (rebateAsset > 0) {
    rebateVault.recordRebate(assetToken, params.to, rebateAsset);
    emit MCVRebatePaid(params.to, params.pool, assetToken, rebateAsset, tier);
}
if (rebateUsdc > 0) {
    rebateVault.recordRebate(usdcToken, params.to, rebateUsdc);
    emit MCVRebatePaid(params.to, params.pool, usdcToken, rebateUsdc, tier);
}

// --- Retention to treasury receivers (record) ---
address assetReceiver = treasury.assetRetentionReceiver();
address usdcReceiver  = treasury.usdcRetentionReceiver();
if (keepAsset > 0) { rebateVault.recordRebate(assetToken, assetReceiver, keepAsset); }
if (keepUsdc  > 0) { rebateVault.recordRebate(usdcToken,  usdcReceiver,  keepUsdc);  }

emit MCVQualified(params.to, params.pool, tier, shareBps);
    }
}
