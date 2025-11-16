// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title LPPQuoterMCV
 * @notice Read-only simulator for LPPRouter.mcvSupplication(..).
 *         - Mirrors per-hop input fee: MCV_FEE_BPS
 *         - Splits fee into treasury (TREASURY_CUT_BPS) + pools donation (MCV_FEE_BPS - TREASURY_CUT_BPS)
 *         - Applies the donation to the *input-side reserve before quoting* (matches router execution order)
 *         - Quotes 3 independent hops using current pool reserves (no state changes)
 *         - Auto-detects dual-orbit; falls back to legacy orbit if dual-orbit not configured
 *
 * Return values include: chosen orbit, direction, per-hop fees, per-hop grossOut, and totals.
 */

interface ILPPPoolView {
    function asset() external view returns (address);
    function usdc() external view returns (address);
    function reserveAsset() external view returns (uint256);
    function reserveUsdc() external view returns (uint256);
}

interface ILPPRouterRead {
    // constants (auto-generated getters for `public constant`)
    function BPS_DENOMINATOR() external view returns (uint16);
    function MCV_FEE_BPS() external view returns (uint16);
    function TREASURY_CUT_BPS() external view returns (uint16);

    // orbit helpers
    function getActiveOrbit(address startPool)
        external
        view
        returns (address[3] memory orbit, bool usingNeg);

    function getDirectionCursor(address startPool)
        external
        view
        returns (bool useAssetToUsdcNext);

    // legacy (single-orbit) helper
    function getOrbit(address startPool)
        external
        view
        returns (address[3] memory pools);
}

contract LPPQuoterMCV {
    struct QuoteResult {
        address[3] orbit;             // pools used for the 3 hops
        bool      usingNeg;           // true=NEG set, false=POS (dual-orbit) or false in legacy
        bool      assetToUsdc;        // true = ASSET->USDC, false = USDC->ASSET
        address   tokenIn;            // common input token across all 3 hops
        address   tokenOut;           // output token per hop (same across hops)
        uint256   perHopFeeTotal;     // amountIn * MCV_FEE_BPS / BPS
        uint256   perHopFeeTreasury;  // amountIn * TREASURY_CUT_BPS / BPS
        uint256   perHopFeePools;     // perHopFeeTotal - perHopFeeTreasury (donation to input reserves)
        uint256[3] amountOutPerHop;   // gross out per hop (post-fee donation, no skims)
        uint256   totalAmountOut;     // sum of 3 hops
    }

    /**
     * @notice Quote the next mcvSupplication(..) result for the given router + startPool.
     * @param router              LPPRouter address
     * @param startPool           the "cursor key" used in router to select orbit set and flip cursors
     * @param amountIn            SAME principal provided to *each* hop (payer principal per hop)
     * @param assetToUsdcLegacy   only used if dual-orbit is NOT configured; ignored otherwise
     *
     * @dev Behavior:
     *  - If dual-orbit is configured, uses router.getActiveOrbit + getDirectionCursor.
     *  - If dual-orbit is not configured, falls back to router.getOrbit and uses the legacy direction param.
     *  - Donation math: donation = amountIn * (MCV_FEE_BPS - TREASURY_CUT_BPS) / BPS.
     *  - Quote math matches LPPPool.quoteSupplication but with input-side reserve += donation before quoting.
     */
    function quoteMCV(
        address router,
        address startPool,
        uint256 amountIn,
        bool assetToUsdcLegacy
    ) external view returns (QuoteResult memory qr) {
        require(amountIn > 0, "amountIn=0");

        ILPPRouterRead r = ILPPRouterRead(router);
        uint256 BPS = uint256(r.BPS_DENOMINATOR());
        uint256 mcvFeeBps = uint256(r.MCV_FEE_BPS());
        uint256 treasuryCutBps = uint256(r.TREASURY_CUT_BPS());
        require(mcvFeeBps >= treasuryCutBps, "bad fee config");

        // --- Determine orbit & direction (dual-orbit -> legacy fallback) ---
        bool dualOk = true;
        address[3] memory orbit;
        bool usingNeg;
        bool assetToUsdc;

        // Try dual-orbit first
        try r.getActiveOrbit(startPool) returns (address[3] memory o, bool neg) {
            orbit = o;
            usingNeg = neg;
            // direction cursor (if dual is set)
            try r.getDirectionCursor(startPool) returns (bool dir) {
                assetToUsdc = dir;
            } catch {
                // Shouldn't happen for dual, but default to legacy param if it does
                assetToUsdc = assetToUsdcLegacy;
            }
        } catch {
            dualOk = false;
        }

        if (!dualOk) {
            // Legacy single-orbit mode
            orbit = r.getOrbit(startPool); // reverts if not configured
            usingNeg = false;
            assetToUsdc = assetToUsdcLegacy;
        }

        // --- Common tokens (identical across the 3 hops by config) ---
        ILPPPoolView p0 = ILPPPoolView(orbit[0]);
        address tokenAsset = p0.asset();
        address tokenUsdc  = p0.usdc();

        qr.orbit       = orbit;
        qr.usingNeg    = usingNeg;
        qr.assetToUsdc = assetToUsdc;
        qr.tokenIn     = assetToUsdc ? tokenAsset : tokenUsdc;
        qr.tokenOut    = assetToUsdc ? tokenUsdc  : tokenAsset;

        // --- Per-hop fee breakdown (same for each hop since amountIn is constant) ---
        uint256 feeTotal     = (amountIn * mcvFeeBps) / BPS;
        uint256 feeTreasury  = (amountIn * treasuryCutBps) / BPS;
        uint256 feeToPools   = feeTotal > feeTreasury ? (feeTotal - feeTreasury) : 0;

        qr.perHopFeeTotal    = feeTotal;
        qr.perHopFeeTreasury = feeTreasury;
        qr.perHopFeePools    = feeToPools;

        // --- Quote each hop independently (donate pools fee to input-side reserves before quoting) ---
        uint256 sumOut = 0;
        for (uint256 i = 0; i < 3; i++) {
            ILPPPoolView pool = ILPPPoolView(orbit[i]);

            // Read current reserves
            uint256 rA = pool.reserveAsset();
            uint256 rU = pool.reserveUsdc();
            require(rA > 0 && rU > 0, "empty reserves");

            // Apply donation to the *input* side reserve (view-only simulation)
            if (feeToPools > 0) {
                if (assetToUsdc) {
                    rA += feeToPools; // ASSET is input on ASSET->USDC
                } else {
                    rU += feeToPools; // USDC is input on USDC->ASSET
                }
            }

            // Use the same placeholder CFMM math as LPPPool.quoteSupplication
            uint256 out;
            if (assetToUsdc) {
                // out = (amountIn * reserveUsdc) / (reserveAsset + amountIn)
                out = (amountIn * rU) / (rA + amountIn);
            } else {
                // out = (amountIn * reserveAsset) / (reserveUsdc + amountIn)
                out = (amountIn * rA) / (rU + amountIn);
            }

            qr.amountOutPerHop[i] = out;
            unchecked { sumOut += out; }
        }

        qr.totalAmountOut = sumOut;
    }
}