// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFAFERouter {
    /* ───────── Single-pool (permissioned) ───────── */
    struct SupplicateParams {
        address pool;          // concrete pool (single-hop)
        bool    assetToUsdc;   // direction for this pool
        uint256 amountIn;      // principal per call
        uint256 minAmountOut;  // slippage guard (single hop)
        address to;            // recipient (defaults msg.sender if zero)
        address payer;         // who pays principal/fee (defaults msg.sender if zero)
    }

    /* ───────── Single-pool swap (permissioned, like supplicate) ───────── */
    struct SwapParams {
        address pool;          // concrete pool (single-hop)
        bool    assetToUsdc;   // direction for this pool
        uint256 amountIn;      // principal per call
        uint256 minAmountOut;  // slippage guard (single hop)
        address to;            // recipient (defaults msg.sender if zero)
        address payer;         // who pays principal (defaults msg.sender if zero)
    }

    /* ───────── Deposit profits back to pool ───────── */
    struct DepositParams {
        address pool;          // pool to deposit profits into
        bool    isUsdc;        // true if depositing USDC, false if depositing asset
        uint256 amount;        // amount to deposit
    }

    /* ───────── Rebalance pools ───────── */
    struct RebalanceParams {
        address sourcePool;    // pool to withdraw from
        address destPool;      // pool to deposit into
        bool    isUsdc;        // true to rebalance USDC, false to rebalance ASSET
    }

    /* ───────── constants used in fee math ───────── */
    function BPS_DENOMINATOR() external view returns (uint16);
    function MCV_FEE_BPS() external view returns (uint16);
    function TREASURY_CUT_BPS() external view returns (uint16);
    function paused() external view returns (bool);

    /* ───────── execution surfaces ───────── */
    function supplicate(SupplicateParams calldata p) external returns (uint256 amountOut); // permissioned single-pool
    function swap(SwapParams calldata p) external returns (uint256 amountOut);              // permissioned single-pool (like supplicate)
    function deposit(DepositParams calldata p) external;                                      // deposit profits back to pool
    function rebalance(RebalanceParams calldata p) external;                                  // rebalance pools (AA-only)

    /* ───────── quoting helpers ───────── */
    function quoteSwap(
        address pool,
        bool assetToUsdc,
        uint256 amountIn
    ) external view returns (uint256 amountOut);



    /* ───────── pause control (treasury-only) ───────── */
    function pause() external;
    function unpause() external;
}