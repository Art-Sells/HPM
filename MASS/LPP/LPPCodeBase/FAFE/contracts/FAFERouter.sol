// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IFAFERouter }          from "./interfaces/IFAFERouter.sol";
import { IFAFEAccessManager }   from "./interfaces/IFAFEAccessManager.sol";
import { IFAFEPool }            from "./interfaces/IFAFEPool.sol";
import { IERC20 }              from "./external/IERC20.sol";

contract FAFERouter is IFAFERouter {
    IFAFEAccessManager public immutable access;
    address public immutable treasury;

    /* -------- Fees (public constants = auto getters) -------- */
    uint16 public constant override BPS_DENOMINATOR = 10_000;
    uint16 public constant override MCV_FEE_BPS      = 120; // 1.2% per hop
    uint16 public constant override TREASURY_CUT_BPS = 20;  // .2% of hop input
    uint16 public constant POOLS_CUT_BPS             = 100; // 1% of hop input

    // Daily cap removed per README requirements

    /* -------- Pause state -------- */
    bool public paused;


    /* -------- Errors -------- */
    error RouterPaused();

    /* -------- Events (MEV traces, admin) -------- */
    event Paused(address indexed account);
    event Unpaused(address indexed account);

    event FeeTaken(
        address indexed pool,
        address indexed tokenIn,
        uint256 amountInBase,
        uint256 totalFee,
        uint256 treasuryCut,
        uint256 poolsCut
    );

    event HopExecuted(
        address indexed pool,
        bool    assetToUsdc,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    event SupplicateExecuted(
        address indexed caller,
        address indexed pool,
        address indexed tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOut,
        uint256 fee
    );

    event SwapExecuted(
        address indexed caller,
        address indexed pool,
        address indexed tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOut
    );

    event DepositExecuted(
        address indexed caller,
        address indexed pool,
        bool indexed isUsdc,
        uint256 amount
    );

    /* -------- Auth -------- */
    modifier onlyTreasury() { require(msg.sender == treasury, "not treasury"); _; }
    modifier whenNotPaused() { if (paused) revert RouterPaused(); _; }

    constructor(address accessManager, address treasury_) {
        require(accessManager != address(0), "zero access");
        require(treasury_ != address(0), "zero treasury");
        access = IFAFEAccessManager(accessManager);
        treasury = treasury_;
    }



    /* ───────────────────────────────────────────
       Pause control (treasury-only)
       ─────────────────────────────────────────── */

    function pause() external onlyTreasury {
        if (paused) return; // idempotent
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyTreasury {
        if (!paused) return; // idempotent
        paused = false;
        emit Unpaused(msg.sender);
    }


    /* ───────────────────────────────────────────
       Single-pool (permissioned) — NO offset flip
       ─────────────────────────────────────────── */

    function supplicate(SupplicateParams calldata p)
        external
        override
        whenNotPaused
        returns (uint256 amountOut)
    {
        require(access.isApprovedSupplicator(msg.sender), "not permitted");
        address payer = p.payer == address(0) ? msg.sender : p.payer;
        address to    = p.to    == address(0) ? msg.sender : p.to;

        address tokenIn  = p.assetToUsdc ? IFAFEPool(p.pool).asset() : IFAFEPool(p.pool).usdc();
        address tokenOut = p.assetToUsdc ? IFAFEPool(p.pool).usdc()  : IFAFEPool(p.pool).asset();

        amountOut = IFAFEPool(p.pool).supplicate(
            payer,
            address(this),
            p.assetToUsdc,
            p.amountIn,
            p.minAmountOut
        );

        IERC20(tokenOut).transfer(to, amountOut);

        emit HopExecuted(p.pool, p.assetToUsdc, tokenIn, tokenOut, p.amountIn, amountOut);
        emit SupplicateExecuted(msg.sender, p.pool, tokenIn, p.amountIn, tokenOut, amountOut, 0);
    }

    /* ───────────────────────────────────────────
       Single-pool swap (permissioned) — flips offset after swap
       ─────────────────────────────────────────── */

    function swap(SwapParams calldata p)
        external
        override
        whenNotPaused
        returns (uint256 amountOut)
    {
        require(access.isDedicatedAA(msg.sender), "only dedicated AA");
        require(p.amountIn > 0, "zero input");
        
        address payer = p.payer == address(0) ? msg.sender : p.payer;
        address to    = p.to    == address(0) ? msg.sender : p.to;

        address tokenIn  = p.assetToUsdc ? IFAFEPool(p.pool).asset() : IFAFEPool(p.pool).usdc();
        address tokenOut = p.assetToUsdc ? IFAFEPool(p.pool).usdc()  : IFAFEPool(p.pool).asset();

        amountOut = IFAFEPool(p.pool).supplicate(
            payer,
            address(this),
            p.assetToUsdc,
            p.amountIn,
            p.minAmountOut
        );

        IERC20(tokenOut).transfer(to, amountOut);

        // After swap completes, flip the offset of the pool
        IFAFEPool(p.pool).flipOffset();

        emit SwapExecuted(msg.sender, p.pool, tokenIn, p.amountIn, tokenOut, amountOut);
        emit HopExecuted(p.pool, p.assetToUsdc, tokenIn, tokenOut, p.amountIn, amountOut);
    }

    /* ───────────────────────────────────────────
       Quoting
       ─────────────────────────────────────────── */

    function quoteSwap(
        address pool,
        bool assetToUsdc,
        uint256 amountIn
    ) external view override returns (uint256 amountOut) {
        require(pool != address(0), "zero pool");
        require(amountIn > 0, "amountIn=0");
        (amountOut, ) = IFAFEPool(pool).quoteSupplication(assetToUsdc, amountIn);
    }

    /* ───────────────────────────────────────────
       Deposit profits back to pool
       ─────────────────────────────────────────── */

    function deposit(DepositParams calldata p) external override whenNotPaused {
        require(access.isDedicatedAA(msg.sender), "not permitted");
        require(p.amount > 0, "zero amount");
        require(p.pool != address(0), "zero pool");

        // Pull tokens from AA (msg.sender) to router first
        // Then pool can pull from router
        address token = p.isUsdc ? IFAFEPool(p.pool).usdc() : IFAFEPool(p.pool).asset();
        require(IERC20(token).transferFrom(msg.sender, address(this), p.amount), "pull deposit fail");
        
        // Now approve pool to pull from router
        require(IERC20(token).approve(p.pool, p.amount), "approve pool fail");

        IFAFEPool(p.pool).donateToReserves(p.isUsdc, p.amount);

        emit DepositExecuted(msg.sender, p.pool, p.isUsdc, p.amount);
    }
}