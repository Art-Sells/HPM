// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPRouter {
    /* ───────── Single-pool (permissioned) ───────── */
    struct SupplicateParams {
        address pool;          // concrete pool (single-hop)
        bool    assetToUsdc;   // direction for this pool
        uint256 amountIn;      // principal per call
        uint256 minAmountOut;  // slippage guard (single hop)
        address to;            // recipient (defaults msg.sender if zero)
        address payer;         // who pays principal/fee (defaults msg.sender if zero)
    }

    /* ───────── Multi-hop MCV (MEV) ─────────
       One struct only; MEVs quote with swap.staticCall(SwapParams({...}))
       Set minTotalAmountOut=0 for pure quotes.
    */
    struct SwapParams {
        address startPool;         // key that selects the orbit
        bool    assetToUsdc;       // selects orbit: true = NEG, false = POS
        uint256 amountIn;          // SAME amount per hop
        address payer;             // defaults msg.sender if zero
        address to;                // defaults msg.sender if zero
        uint256 minTotalAmountOut; // aggregate slippage guard across all hops (0 to ignore)
    }

    /* ───────── constants used in fee math ───────── */
    function BPS_DENOMINATOR() external view returns (uint16);
    function MCV_FEE_BPS() external view returns (uint16);
    function TREASURY_CUT_BPS() external view returns (uint16);
    function dailyEventCap() external view returns (uint16);
    function dailyEventCount() external view returns (uint16);
    function paused() external view returns (bool);

    /* ───────── execution surfaces ───────── */
    function supplicate(SupplicateParams calldata p) external returns (uint256 amountOut); // permissioned single-pool
    function swap(SwapParams calldata p) external returns (uint256 totalAmountOut);        // MEV multi-hop (quote via staticCall)

    /* ───────── quoting helpers ───────── */
    function getAmountsOut(
        uint256 amountIn,
        address[] calldata orbit,
        bool assetToUsdc
    ) external view returns (uint256[] memory perHop, uint256 total);

    function getAmountsOutFromStart(
        address startPool,
        uint256 amountIn
    )
        external
        view
        returns (
            bool assetToUsdc,         // derived from active set if dual-orbit
            address[] memory orbit,  // the pools used for this call
            uint256[] memory perHop,
            uint256 total
        );

    /* ───────── treasury-only orbit wiring ───────── */
    function setOrbit(address startPool, address[] calldata pools) external;
    function setDualOrbit(address startPool, address[] calldata neg, address[] calldata pos, bool startWithNeg) external;

    /* ───────── inspectors used by tests ───────── */
    function getActiveOrbit(address startPool) external view returns (address[] memory orbit, bool usingNeg);
    function getDualOrbit(address startPool) external view returns (address[] memory neg, address[] memory pos, bool usingNeg);

    /* ───────── daily event guard ───────── */
    function setDailyEventCap(uint16 newCap) external;
    function getDailyEventWindow() external view returns (uint32 dayIndex, uint16 count, uint16 cap);

    /* ───────── pause control (treasury-only) ───────── */
    function pause() external;
    function unpause() external;
}