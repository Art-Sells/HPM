// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPRouter } from "./interfaces/ILPPRouter.sol";
import { ILPPAccessManager } from "./interfaces/ILPPAccessManager.sol";
import { ILPPPool } from "./interfaces/ILPPPool.sol";
import { IERC20 } from "./external/IERC20.sol";

contract LPPRouter is ILPPRouter {
    ILPPAccessManager public immutable access;
    address public immutable treasury;

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MCV_FEE_BPS      = 250; // 2.5% protocol fee on profit

    constructor(address accessManager, address treasury_) {
        require(accessManager != address(0), "zero access");
        require(treasury_ != address(0), "zero treasury");
        access = ILPPAccessManager(accessManager);
        treasury = treasury_;
    }

    /// -----------------------------------------------------------------------
    /// Single-pool supplicate (Treasury-approved only)
    /// -----------------------------------------------------------------------
    function supplicate(SupplicateParams calldata p)
        external
        override
        returns (uint256 amountOut)
    {
        // permission: approved supplicator ONLY (Phase 0)
        bool permitted = access.isApprovedSupplicator(msg.sender);
        require(permitted, "not permitted");

        address payer = p.payer == address(0) ? msg.sender : p.payer;
        address to    = p.to == address(0) ? msg.sender : p.to;

        amountOut = ILPPPool(p.pool).supplicate(
            payer,
            to,
            p.assetToUsdc,
            p.amountIn,
            p.minAmountOut
        );

        address assetIn  = p.assetToUsdc ? ILPPPool(p.pool).asset() : ILPPPool(p.pool).usdc();
        address assetOut = p.assetToUsdc ? ILPPPool(p.pool).usdc() : ILPPPool(p.pool).asset();

        emit SupplicateExecuted(msg.sender, p.pool, assetIn, p.amountIn, assetOut, amountOut, 0);
    }

    /// -----------------------------------------------------------------------
    /// 3-pool orbit MCV-style supplication (anyone)
    /// -----------------------------------------------------------------------
    function mcvSupplication(MCVParams calldata params)
        external
        override
        returns (
            uint256 finalAmountOut,
            uint256 grossProfit,
            uint256 fee,
            uint256 treasuryCut
        )
    {
        require(params.amountIn > 0, "zero input");

        // Derive starting token from first hop.
        address firstPool = params.hops[0].pool;
        bool firstDir     = params.hops[0].assetToUsdc;

        address startToken = firstDir
            ? ILPPPool(firstPool).asset()
            : ILPPPool(firstPool).usdc();

        uint256 amount = params.amountIn;

        address payer = params.payer == address(0) ? msg.sender : params.payer;
        address to    = params.to == address(0) ? msg.sender : params.to;

        // --------------------------------------------------------------------
        // Hop 0: payer -> pool[0] -> router
        // --------------------------------------------------------------------
        amount = _executeHop(params.hops[0], amount, payer, address(this));

        // --------------------------------------------------------------------
        // Hop 1: router -> pool[1] -> router
        // --------------------------------------------------------------------
        amount = _executeHop(params.hops[1], amount, address(this), address(this));

        // --------------------------------------------------------------------
        // Hop 2: router -> pool[2] -> router
        // --------------------------------------------------------------------
        amount = _executeHop(params.hops[2], amount, address(this), address(this));

        finalAmountOut = amount;

        // Profit calculation in starting token
        if (finalAmountOut > params.amountIn) {
            grossProfit = finalAmountOut - params.amountIn;
        } else {
            grossProfit = 0;
        }

        require(grossProfit >= params.minProfit && grossProfit > 0, "no profit");

        // --------------------------------------------------------------------
        // Fee + payout
        // --------------------------------------------------------------------
        fee = (grossProfit * MCV_FEE_BPS) / BPS_DENOMINATOR; // 2.5% of profit
        treasuryCut = fee; // Phase 0: entire fee to Treasury (simple model)

        // Router currently holds finalAmountOut of the start token.
        // Pay Treasury first.
        if (treasuryCut > 0) {
            IERC20(startToken).transfer(treasury, treasuryCut);
        }

        // Pay remaining to `to`
        uint256 netToUser = finalAmountOut - fee;
        IERC20(startToken).transfer(to, netToUser);
    }

    /// -----------------------------------------------------------------------
    /// Internal helpers
    /// -----------------------------------------------------------------------
    function _executeHop(
        OrbitHop memory hop,
        uint256 amountIn,
        address payer,
        address recipient
    ) internal returns (uint256 amountOut) {
        require(hop.pool != address(0), "zero pool");
        require(amountIn > 0, "zero hop amount");

        address pool = hop.pool;
        bool assetToUsdc = hop.assetToUsdc;

        address tokenIn = assetToUsdc
            ? ILPPPool(pool).asset()
            : ILPPPool(pool).usdc();

        // If router is paying, it must approve pool to pull tokens.
        if (payer == address(this)) {
            IERC20(tokenIn).approve(pool, amountIn);
        }

        amountOut = ILPPPool(pool).supplicate(
            payer,
            recipient,
            assetToUsdc,
            amountIn,
            0 // slippage handled off-chain in searcher logic for Phase 0
        );
    }
}