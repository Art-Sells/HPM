// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPSupplicationQuoter } from "./interfaces/ILPPSupplicationQuoter.sol";
import { ILPPPool } from "./interfaces/ILPPPool.sol";

contract LPPSupplicationQuoter is ILPPSupplicationQuoter {
    function quoteSupplication(address pool, bool assetToUsdc, uint256 amountIn) external view override returns (Quote memory q) {
        (uint256 amountOut, int256 drift) = ILPPPool(pool).quoteSupplication(assetToUsdc, amountIn);
        // For scaffold, liquidityBefore/After are approximated by reserves sum via public view (not provided fully here).
        // Replace with real pool getters as pool matures.
        q = Quote({
            expectedAmountOut: amountOut,
            impactRatioBps: drift,
            liquidityBefore: 0,
            liquidityAfter: 0,
            priceDriftBps: drift
        });
    }
}
