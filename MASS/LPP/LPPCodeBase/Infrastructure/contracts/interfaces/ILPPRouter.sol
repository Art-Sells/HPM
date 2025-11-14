// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPRouter {
    event SupplicateExecuted(
        address indexed caller,
        address indexed pool,
        address assetIn,
        uint256 amountIn,
        address assetOut,
        uint256 amountOut,
        uint8 reason
    );

    /// @notice Single-pool supplication (Phase 0: Treasury-approved addresses only).
    struct SupplicateParams {
        address pool;
        bool assetToUsdc;
        uint256 amountIn;
        uint256 minAmountOut;
        address to;
        address payer; // who provides the input tokens; defaults to msg.sender if zero
    }

    /// @notice One hop in a fixed 3-pool orbit.
    struct OrbitHop {
        address pool;
        bool assetToUsdc;
    }

    /// @notice Params for Phase 0 MCV-style 3-pool orbit.
    struct MCVParams {
        OrbitHop[3] hops;   // exactly 3 hops
        uint256 amountIn;   // starting amount in the first hop's input token
        uint256 minProfit;  // required profit in the same token as amountIn
        address payer;      // who provides the starting tokens (defaults to msg.sender if zero)
        address to;         // final recipient of net proceeds (defaults to msg.sender if zero)
    }

    /// @notice Simple one-pool supplication.
    function supplicate(SupplicateParams calldata params) external returns (uint256 amountOut);

    /// @notice 3-pool orbit "MCV supplication" (Phase 0): open to anyone.
    /// @dev Applies a protocol fee on profit and pays it to the Treasury.
    /// @return finalAmountOut Final amount after all 3 hops.
    /// @return grossProfit    finalAmountOut - amountIn (0 if no profit).
    /// @return fee            protocol fee charged on grossProfit.
    /// @return treasuryCut    amount transferred to the Treasury.
    function mcvSupplication(MCVParams calldata params)
        external
        returns (
            uint256 finalAmountOut,
            uint256 grossProfit,
            uint256 fee,
            uint256 treasuryCut
        );
}