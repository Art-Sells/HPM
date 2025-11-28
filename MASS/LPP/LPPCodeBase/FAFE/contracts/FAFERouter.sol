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
    uint16 public constant DEPOSIT_TREASURY_CUT_BPS  = 500; // 5% of deposit to treasury

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
        uint256 amount,
        uint256 treasuryCut,
        uint256 poolAmount
    );

    event RebalanceExecuted(
        address indexed caller,
        address indexed sourcePool,
        address indexed destPool,
        bool isUsdc,
        uint256 amountMoved
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
        address token = p.isUsdc ? IFAFEPool(p.pool).usdc() : IFAFEPool(p.pool).asset();
        require(IERC20(token).transferFrom(msg.sender, address(this), p.amount), "pull deposit fail");
        
        // Calculate 10% treasury cut
        uint256 treasuryCut = (p.amount * DEPOSIT_TREASURY_CUT_BPS) / BPS_DENOMINATOR;
        uint256 poolAmount = p.amount - treasuryCut;
        
        // Send 5% to treasury
        if (treasuryCut > 0) {
            require(IERC20(token).transfer(treasury, treasuryCut), "treasury transfer fail");
        }
        
        // Approve pool to pull remaining 90% from router
        require(IERC20(token).approve(p.pool, poolAmount), "approve pool fail");

        IFAFEPool(p.pool).donateToReserves(p.isUsdc, poolAmount);

        emit DepositExecuted(msg.sender, p.pool, p.isUsdc, p.amount, treasuryCut, poolAmount);
    }

    /* ───────────────────────────────────────────
       Rebalance pools (AA-only)
       ─────────────────────────────────────────── */

    function rebalance(RebalanceParams calldata p) external override whenNotPaused {
        require(access.isDedicatedAA(msg.sender), "not permitted");
        require(p.sourcePool != address(0) && p.destPool != address(0), "zero pool");
        require(p.sourcePool != p.destPool, "same pool");

        // Get reserves from both pools
        uint256 sourceReserve = p.isUsdc 
            ? IFAFEPool(p.sourcePool).reserveUsdc()
            : IFAFEPool(p.sourcePool).reserveAsset();
        
        uint256 destReserve = p.isUsdc
            ? IFAFEPool(p.destPool).reserveUsdc()
            : IFAFEPool(p.destPool).reserveAsset();

        // Check if source has at least 5% more than destination
        // If destReserve is 0, we can't calculate percentage, so skip
        require(destReserve > 0, "dest reserve zero");
        
        // Calculate: sourceReserve / destReserve should be >= 1.05 (5% more)
        // Using: sourceReserve * 10000 >= destReserve * 10500
        uint256 sourceScaled = sourceReserve * 10000;
        uint256 destScaled = destReserve * 10500;
        
        require(sourceScaled >= destScaled, "imbalance too small");

        // Calculate 2.5% of source reserve to move
        uint256 amountToMove = (sourceReserve * 250) / 10000; // 2.5% = 250 bps
        require(amountToMove > 0, "zero amount");

        // Withdraw from source pool (to router)
        IFAFEPool(p.sourcePool).withdrawForRebalance(p.isUsdc, amountToMove, address(this));

        // Get token address
        address token = p.isUsdc 
            ? IFAFEPool(p.destPool).usdc() 
            : IFAFEPool(p.destPool).asset();

        // Approve destination pool to pull from router
        require(IERC20(token).approve(p.destPool, amountToMove), "approve dest pool fail");

        // Deposit into destination pool (no treasury cut for rebalancing)
        IFAFEPool(p.destPool).donateToReserves(p.isUsdc, amountToMove);

        emit RebalanceExecuted(msg.sender, p.sourcePool, p.destPool, p.isUsdc, amountToMove);
    }
}