// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPSupplicationQuoter {
    struct Quote {
        uint256 expectedAmountOut;
        int256 impactRatioBps;
        uint256 liquidityBefore;
        uint256 liquidityAfter;
        int256 priceDriftBps;
    }

    function quoteSupplication(address pool, bool assetToUsdc, uint256 amountIn) external view returns (Quote memory);
}
