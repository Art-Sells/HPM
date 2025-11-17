// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPRouter {
    // -------- Constants --------
    function BPS_DENOMINATOR() external view returns (uint16);
    function MCV_FEE_BPS() external view returns (uint16);

    // -------- Types --------
    struct SupplicateParams {
        address pool;
        bool assetToUsdc;
        uint256 amountIn;
        uint256 minAmountOut;
        address to;      // optional; defaults to msg.sender
        address payer;   // optional; defaults to msg.sender
    }

    struct MCVParams {
        address startPool;         // key used to look up orbit sets
        bool    assetToUsdc;       // direction of hop 0 (legacy mode only)
        uint256 amountIn;          // hop input amount for each hop (independent hops mode)
        address payer;             // external wallet that funds input (+ fee)
        address to;                // receiver of output
        uint256 minTotalAmountOut; // NEW: aggregate minOut across all 3 hops
    }

    // -------- Events (declare here only; do NOT redeclare in the contract) --------
    event OrbitUpdated(address indexed startPool, address[3] pools);
    event DualOrbitUpdated(address indexed startPool, address[3] neg, address[3] pos, bool useNeg);
    event OrbitFlipped(address indexed startPool, bool nowUsingNeg);

    event HopExecuted(
        address indexed pool,
        bool assetToUsdc,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 grossOut
    );

    event FeeTaken(
        address indexed pool,
        address indexed token,   // fee token (hop input token)
        uint256 amountBase,      // hop amountIn on which fee was computed
        uint256 totalFee,        // e.g. 12 bps per hop
        uint256 treasuryFee,     // e.g. 2 bps per hop
        uint256 poolsFee         // e.g. 10 bps per hop
    );

    event SupplicateExecuted(
        address indexed caller,
        address indexed pool,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOut,
        uint256 /*reserved*/
    );

    // -------- Config --------
    function setOrbit(address startPool, address[3] calldata pools_) external; // legacy (still supported)
    function getOrbit(address startPool) external view returns (address[3] memory pools); // legacy view

    // Dual-orbit API (selects which set will be used on the NEXT call)
    function setDualOrbit(address startPool, address[3] calldata neg, address[3] calldata pos, bool startWithNeg) external;
    function getActiveOrbit(address startPool) external view returns (address[3] memory orbit, bool usingNeg);
    function getDualOrbit(address startPool) external view returns (address[3] memory neg, address[3] memory pos, bool usingNeg);

    // -------- Actions --------
    function supplicate(SupplicateParams calldata p) external returns (uint256 amountOut);

    // Base MCV path (now expects the extended MCVParams with minTotalAmountOut)
    function mcvSupplication(MCVParams calldata p) external returns (uint256 finalAmountOut);

    // -------- Optional (recommended) bundle-friendly surfaces --------
    // Include these if you want typed calls via the interface. Safe to remove if you prefer a minimal interface.

    /// Return ABI-encoded calldata for mcvSupplication(p) and some helpful context.
    function buildMCVCalldata(
        MCVParams calldata p
    ) external view returns (
        bytes memory data,
        address[3] memory orbit,
        bool assetToUsdc,
        address tokenIn,
        address tokenOut
    );

    /// Execute MCV, then invoke a callback with post-exec context (useful for bundlers/searchers).
    function mcvSupplicationAndCallback(
        MCVParams calldata params,
        address callback,
        bytes calldata context
    ) external returns (uint256 finalAmountOut);
}