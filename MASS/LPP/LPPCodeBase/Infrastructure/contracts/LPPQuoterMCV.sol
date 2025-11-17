// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title LPPQuoterMCV
 * @notice Read-only simulator for LPPRouter.mcvSupplication(..).
 *         Adds:
 *           - (5) minTotalAmountOut hint + meetsMinTotal flag (view-only; no revert)
 *           - (16) MEV-friendly fail code for orbit-not-set (custom error)
 *         Compatibility:
 *           - Exposes BOTH quoteMCV overloads:
 *               (router,startPool,amountIn,legacyDir)
 *               (router,startPool,amountIn,legacyDir,minTotalAmountOut)
 */

interface ILPPPoolView {
    function asset() external view returns (address);
    function usdc() external view returns (address);
    function reserveAsset() external view returns (uint256);
    function reserveUsdc() external view returns (uint256);
}

interface ILPPRouterRead {
    // constants
    function BPS_DENOMINATOR() external view returns (uint16);
    function MCV_FEE_BPS() external view returns (uint16);
    function TREASURY_CUT_BPS() external view returns (uint16);

    // orbits
    function getActiveOrbit(address startPool)
        external
        view
        returns (address[3] memory orbit, bool usingNeg);

    function getOrbit(address startPool)
        external
        view
        returns (address[3] memory pools);

    // optional monitor (not required by quoter logic)
    function getDirectionCursor(address startPool)
        external
        view
        returns (bool useAssetToUsdcNext);
}

// Custom error aligned with router’s style (MEV-friendly fail codes)
error OrbitNotSet(address startPool);

contract LPPQuoterMCV {
    struct QuoteResult {
        address[3] orbit;
        bool      usingNeg;            // true  => NEG set active
        bool      assetToUsdc;         // true  => ASSET-in (ASSET->USDC), false => USDC-in
        address   tokenIn;
        address   tokenOut;
        uint256   perHopFeeTotal;      // amountIn * MCV_FEE_BPS / BPS
        uint256   perHopFeeTreasury;   // amountIn * TREASURY_CUT_BPS / BPS
        uint256   perHopFeePools;      // perHopFeeTotal - perHopFeeTreasury
        uint256[3] amountOutPerHop;    // per-hop gross outs with donation applied
        uint256   totalAmountOut;

        // Aggregate slippage hint (no revert in quoter)
        uint256   minTotalAmountOut;   // echo of caller-provided threshold
        bool      meetsMinTotal;       // totalAmountOut >= minTotalAmountOut (or min==0)
    }

    /* ───────────────────────────────────────────────────────────────────────
       Public API — keep BOTH overloads for ABI compatibility with tests
       ─────────────────────────────────────────────────────────────────────── */

    /// 4-arg overload (legacy-compatible). minTotalAmountOut treated as 0.
    function quoteMCV(
        address router,
        address startPool,
        uint256 amountIn,
        bool assetToUsdcLegacy
    ) external view returns (QuoteResult memory qr) {
        qr = _quoteCore(router, startPool, amountIn, assetToUsdcLegacy);
        // For 4-arg path, we don’t enforce any aggregate slippage bound.
        qr.minTotalAmountOut = 0;
        qr.meetsMinTotal = true;
    }

    /// 5-arg overload (includes aggregate minTotalAmountOut hint).
    function quoteMCV(
        address router,
        address startPool,
        uint256 amountIn,
        bool assetToUsdcLegacy,
        uint256 minTotalAmountOut
    ) external view returns (QuoteResult memory qr) {
        qr = _quoteCore(router, startPool, amountIn, assetToUsdcLegacy);
        qr.minTotalAmountOut = minTotalAmountOut;
        qr.meetsMinTotal = (minTotalAmountOut == 0 || qr.totalAmountOut >= minTotalAmountOut);
    }

    /* ───────────────────────────────────────────────────────────────────────
       Internals
       ─────────────────────────────────────────────────────────────────────── */

    function _quoteCore(
        address router_,
        address startPool,
        uint256 amountIn,
        bool assetToUsdcLegacy
    ) internal view returns (QuoteResult memory qr) {
        require(amountIn > 0, "amountIn=0");

        ILPPRouterRead r = ILPPRouterRead(router_);

        // Fetch router fee constants
        uint256 BPS = uint256(r.BPS_DENOMINATOR());
        uint256 mcvFeeBps = uint256(r.MCV_FEE_BPS());
        uint256 treasuryCutBps = uint256(r.TREASURY_CUT_BPS());
        require(mcvFeeBps >= treasuryCutBps, "bad fee config");

        // Resolve orbit + direction (prefer dual-orbit; fallback to legacy)
        (qr.orbit, qr.usingNeg, qr.assetToUsdc) =
            _resolveOrbitAndDirection(r, startPool, assetToUsdcLegacy);

        // Determine tokenIn/tokenOut from first pool + direction
        {
            ILPPPoolView p0 = ILPPPoolView(qr.orbit[0]);
            address tokenAsset = p0.asset();
            address tokenUsdc  = p0.usdc();
            qr.tokenIn  = qr.assetToUsdc ? tokenAsset : tokenUsdc;
            qr.tokenOut = qr.assetToUsdc ? tokenUsdc  : tokenAsset;
        }

        // Router fee breakdown (computed per hop on amountIn)
        uint256 feeTotal    = (amountIn * mcvFeeBps) / BPS;
        uint256 feeTreasury = (amountIn * treasuryCutBps) / BPS;
        uint256 feeToPools  = feeTotal > feeTreasury ? (feeTotal - feeTreasury) : 0;
        qr.perHopFeeTotal    = feeTotal;
        qr.perHopFeeTreasury = feeTreasury;
        qr.perHopFeePools    = feeToPools;

        // Simulate 3 independent hops: donation applied to INPUT reserve before swap math
        uint256 sumOut = 0;
        for (uint256 i = 0; i < 3; i++) {
            ILPPPoolView pool = ILPPPoolView(qr.orbit[i]);
            uint256 rA = pool.reserveAsset();
            uint256 rU = pool.reserveUsdc();
            if (rA == 0 || rU == 0) revert OrbitNotSet(startPool); // treat empty pool as unusable

            if (feeToPools > 0) {
                if (qr.assetToUsdc) rA += feeToPools; // ASSET-in => donate to asset (input) reserve
                else                rU += feeToPools; // USDC-in  => donate to usdc  (input) reserve
            }

            // Constant-product style (pool-level fee assumed 0; router charges externally)
            // out = dx * rOut / (rIn + dx)
            uint256 out = qr.assetToUsdc
                ? (amountIn * rU) / (rA + amountIn) // ASSET-in → USDC-out
                : (amountIn * rA) / (rU + amountIn); // USDC-in  → ASSET-out

            qr.amountOutPerHop[i] = out;
            unchecked { sumOut += out; }
        }

        qr.totalAmountOut = sumOut;
    }

    /// Resolve active orbit & trade direction:
    /// - If dual-orbit is set on the router, use getActiveOrbit(startPool):
    ///     usingNeg=true  => ASSET-in (asset->usdc)
    ///     usingNeg=false => USDC-in  (usdc->asset)
    /// - If router reverts (legacy), fallback to getOrbit(startPool) and legacyAssetToUsdc flag.
    function _resolveOrbitAndDirection(
        ILPPRouterRead r,
        address startPool,
        bool legacyAssetToUsdc
    )
        internal
        view
        returns (address[3] memory orbit, bool usingNeg, bool assetToUsdc)
    {
        // Try dual-orbit first
        try r.getActiveOrbit(startPool) returns (address[3] memory o, bool neg) {
            orbit = o;
            usingNeg = neg;
            assetToUsdc = neg ? true : false; // NEG => ASSET-in
        } catch {
            // Legacy fallback (single orbit)
            try r.getOrbit(startPool) returns (address[3] memory o) {
                orbit = o;
                usingNeg = false;                // not meaningful in legacy
                assetToUsdc = legacyAssetToUsdc; // provided by caller
            } catch {
                revert OrbitNotSet(startPool);
            }
        }
    }
}