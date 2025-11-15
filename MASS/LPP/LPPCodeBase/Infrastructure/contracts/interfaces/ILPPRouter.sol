// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPRouter {
    // -----------------------------------------------------------------------
    // Structs
    // -----------------------------------------------------------------------

    struct SupplicateParams {
        address pool;
        bool assetToUsdc;
        uint256 amountIn;
        uint256 minAmountOut;
        address payer; // if zero => msg.sender
        address to;    // if zero => msg.sender
    }

    struct MCVParams {
        address startPool;   // pool chosen by MEV (e.g. -500 bps center)
        bool assetToUsdc;    // direction of FIRST hop
        uint256 amountIn;    // input amount in starting token
        uint256 minProfit;   // minimum acceptable profit in starting token
        address payer;       // who provides initial tokens (if zero => msg.sender)
        address to;          // where net profit is sent (if zero => msg.sender)
    }

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event SupplicateExecuted(
        address indexed caller,
        address indexed pool,
        address indexed tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOut,
        uint256 reasonCode // phase-0: 0 = OK
    );

    /// Emitted when the Treasury configures a 3-pool orbit for a given startPool.
    event OrbitUpdated(address indexed startPool, address[3] pools);

    // -----------------------------------------------------------------------
    // External functions
    // -----------------------------------------------------------------------

    function supplicate(SupplicateParams calldata p)
        external
        returns (uint256 amountOut);

    function mcvSupplication(MCVParams calldata params)
        external
        returns (
            uint256 finalAmountOut,
            uint256 grossProfit,
            uint256 fee,
            uint256 treasuryCut
        );

    // Constants
    function BPS_DENOMINATOR() external view returns (uint16);
    function MCV_FEE_BPS() external view returns (uint16);
}