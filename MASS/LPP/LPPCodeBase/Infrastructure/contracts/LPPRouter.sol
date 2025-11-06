// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPRouter } from "./interfaces/ILPPRouter.sol";
import { ILPPAccessManager } from "./interfaces/ILPPAccessManager.sol";
import { ILPPPool } from "./interfaces/ILPPPool.sol";

contract LPPRouter is ILPPRouter {
    ILPPAccessManager public immutable access;

    constructor(address accessManager) {
        access = ILPPAccessManager(accessManager);
    }

    function _isLPMCV(address pool, address caller) internal view returns (bool) {
        try ILPPPool(pool).liquidityOf(caller) returns (uint256 liq) {
            return liq > 0;
        } catch {
            return false;
        }
    }

    function supplicate(SupplicateParams calldata p) external returns (uint256 amountOut) {
        bool permitted = access.isApprovedSupplicator(msg.sender) || _isLPMCV(p.pool, msg.sender);
        require(permitted, "not permitted");

        amountOut = ILPPPool(p.pool).supplicate(p.to, p.assetToUsdc, p.amountIn, p.minAmountOut);
        address assetIn  = p.assetToUsdc ? ILPPPool(p.pool).asset() : ILPPPool(p.pool).usdc();
        address assetOut = p.assetToUsdc ? ILPPPool(p.pool).usdc() : ILPPPool(p.pool).asset();
        emit SupplicateExecuted(msg.sender, p.pool, assetIn, p.amountIn, assetOut, amountOut, 0);
    }
}
