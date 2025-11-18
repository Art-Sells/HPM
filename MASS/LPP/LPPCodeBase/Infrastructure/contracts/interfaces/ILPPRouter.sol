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

    // NOTE: kept for orbit cursor + views (no longer executed by router)
    struct MCVParams {
        address startPool;
        bool    assetToUsdc;
        uint256 amountIn;
        address payer;
        address to;
        uint256 minTotalAmountOut;
    }

    // -------- Events (unchanged) --------
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
        address indexed token,
        uint256 amountBase,
        uint256 totalFee,
        uint256 treasuryFee,
        uint256 poolsFee
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
    function setOrbit(address startPool, address[3] calldata pools_) external;
    function getOrbit(address startPool) external view returns (address[3] memory pools);

    function setDualOrbit(address startPool, address[3] calldata neg, address[3] calldata pos, bool startWithNeg) external;
    function getActiveOrbit(address startPool) external view returns (address[3] memory orbit, bool usingNeg);
    function getDualOrbit(address startPool) external view returns (address[3] memory neg, address[3] memory pos, bool usingNeg);

    // -------- Actions --------
    function supplicate(SupplicateParams calldata p) external returns (uint256 amountOut);

    // -------- Views for MEVs (V2-style math across a 3-pool orbit) --------
    function getAmountsOut(
        uint256 amountIn,
        address[3] calldata orbit,
        bool assetToUsdc
    ) external view returns (uint256[3] memory perHop, uint256 total);
}