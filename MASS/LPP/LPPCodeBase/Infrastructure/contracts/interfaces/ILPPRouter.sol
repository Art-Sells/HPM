// interfaces/ILPPRouter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPRouter {
    // ---------- Types ----------
    struct SupplicateParams {
        address pool;
        bool    assetToUsdc;
        uint256 amountIn;
        uint256 minAmountOut;
        address payer;
        address to;
    }

    struct MCVParams {
        address startPool;
        bool    assetToUsdc;
        uint256 amountIn;
        address payer;
        address to;
    }

    // ---------- Constant getters ----------
    function BPS_DENOMINATOR() external view returns (uint16);
    function MCV_FEE_BPS()     external view returns (uint16);

    // ---------- Events ----------
    event OrbitUpdated(address indexed startPool, address[3] pools);

    event SupplicateExecuted(
        address indexed caller,
        address indexed pool,
        address indexed tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOut,
        uint256 profit   // keep if you use it in tests; otherwise set to 0 when emitting
    );

    // 🔥 Add this:
    event InputFeeTaken(
        address indexed pool,
        address indexed tokenIn,
        uint256 amountInBase,   // hop input on which fee was computed
        uint256 totalFee,       // 2.5%
        uint256 treasuryFee,    // 0.5%
        uint256 poolsFee        // 2.0%
    );

    // ---------- Admin ----------
    function setOrbit(address startPool, address[3] calldata pools_) external;
    function getOrbit(address startPool) external view returns (address[3] memory pools);

    // ---------- Actions ----------
    function supplicate(SupplicateParams calldata p) external returns (uint256 amountOut);
    function mcvSupplication(MCVParams calldata params) external returns (uint256 finalAmountOut);
}