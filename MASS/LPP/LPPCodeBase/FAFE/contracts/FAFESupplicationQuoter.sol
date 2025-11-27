// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IFAFESupplicationQuoter } from "./interfaces/IFAFESupplicationQuoter.sol";
import { IFAFEPool } from "./interfaces/IFAFEPool.sol";

contract FAFESupplicationQuoter is IFAFESupplicationQuoter {
    function quoteSupplication(address pool, bool assetToUsdc, uint256 amountIn) external view override returns (Quote memory q) {
        (uint256 amountOut, int256 drift) = IFAFEPool(pool).quoteSupplication(assetToUsdc, amountIn);
        uint256 rA = IFAFEPool(pool).reserveAsset();
        uint256 rU = IFAFEPool(pool).reserveUsdc();
        q.expectedAmountOut = amountOut;
        q.impactRatioBps    = drift;
        q.liquidityBefore   = rA + rU;
        if (assetToUsdc) {
            q.liquidityAfter = (rA + amountIn) + (rU > amountOut ? (rU - amountOut) : 0);
        } else {
            q.liquidityAfter = (rU + amountIn) + (rA > amountOut ? (rA - amountOut) : 0);
        }
        q.priceDriftBps     = drift;
    }
}
