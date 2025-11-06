// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPRouter {
    event SupplicateExecuted(address indexed caller, address indexed pool, address assetIn, uint256 amountIn, address assetOut, uint256 amountOut, uint8 reason);
    struct SupplicateParams {
        address pool;
        bool assetToUsdc;
        uint256 amountIn;
        uint256 minAmountOut;
        address to;
    }

    function supplicate(SupplicateParams calldata params) external returns (uint256 amountOut);
}
