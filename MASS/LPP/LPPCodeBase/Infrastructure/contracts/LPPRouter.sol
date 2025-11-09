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

    function supplicate(SupplicateParams calldata p)
        external
        override
        returns (uint256 amountOut)
    {
        // permission: approved supplicator OR LP-MCV on that pool
        bool permitted = access.isApprovedSupplicator(msg.sender) || _isLPMCV(p.pool, msg.sender);
        require(permitted, "not permitted");

        // route through pool; caller is the payer of input tokens
        amountOut = ILPPPool(p.pool).supplicate(
            msg.sender,           // payer
            p.to,                 // recipient
            p.assetToUsdc,        // direction
            p.amountIn,           // exact in
            p.minAmountOut        // slippage guard
        );

        // book-keeping event (reason=0 reserved for "OK")
        address assetIn  = p.assetToUsdc ? ILPPPool(p.pool).asset() : ILPPPool(p.pool).usdc();
        address assetOut = p.assetToUsdc ? ILPPPool(p.pool).usdc() : ILPPPool(p.pool).asset();
        emit SupplicateExecuted(msg.sender, p.pool, assetIn, p.amountIn, assetOut, amountOut, 0);
    }
}