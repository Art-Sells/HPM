// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPRouter } from "./interfaces/ILPPRouter.sol";
import { ILPPAccessManager } from "./interfaces/ILPPAccessManager.sol";
import { ILPPPool } from "./interfaces/ILPPPool.sol";
import { IERC20 } from "./external/IERC20.sol";

contract LPPRouter is ILPPRouter {
    ILPPAccessManager public immutable access;
    address public immutable treasury;

    // Exposed as constants that satisfy ILPPRouter getters
    uint16 public constant override BPS_DENOMINATOR = 10_000;
    uint16 public constant override MCV_FEE_BPS      = 250; // 2.5%
    uint16 public constant TREASURY_CUT_BPS          = 50;  // 0.5% (of hop output)
    uint16 public constant POOLS_CUT_BPS             = 200; // 2.0% (of hop output)

    struct OrbitConfig { address[3] pools; bool initialized; }
    mapping(address => OrbitConfig) private _orbitOf;

    // Keep only this event locally (others like OrbitUpdated are assumed declared in ILPPRouter)
    event FeeTaken(
        address indexed pool,
        address indexed token,
        uint256 grossOut,
        uint256 totalFee,
        uint256 treasuryFee,
        uint256 poolsFee
    );

    modifier onlyTreasury() {
        require(msg.sender == treasury, "not treasury");
        _;
    }

    constructor(address accessManager, address treasury_) {
        require(accessManager != address(0), "zero access");
        require(treasury_ != address(0), "zero treasury");
        access = ILPPAccessManager(accessManager);
        treasury = treasury_;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Orbit config
    // ─────────────────────────────────────────────────────────────────────────────

    function setOrbit(address startPool, address[3] calldata pools_) external onlyTreasury {
        require(startPool != address(0), "orbit: zero start");
        require(
            pools_[0] != address(0) && pools_[1] != address(0) && pools_[2] != address(0),
            "orbit: zero pool"
        );

        // Enforce same asset/usdc across all hops
        address a0 = ILPPPool(pools_[0]).asset();
        address u0 = ILPPPool(pools_[0]).usdc();
        require(ILPPPool(pools_[1]).asset() == a0 && ILPPPool(pools_[1]).usdc() == u0, "orbit: mismatched pair");
        require(ILPPPool(pools_[2]).asset() == a0 && ILPPPool(pools_[2]).usdc() == u0, "orbit: mismatched pair");

        _orbitOf[startPool] = OrbitConfig({ pools: pools_, initialized: true });
        emit OrbitUpdated(startPool, pools_);
    }

    function getOrbit(address startPool) external view returns (address[3] memory pools) {
        OrbitConfig memory cfg = _orbitOf[startPool];
        require(cfg.initialized, "orbit: not set");
        return cfg.pools;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Single-pool supplicate (approved-only)
    // ─────────────────────────────────────────────────────────────────────────────

    function supplicate(SupplicateParams calldata p)
        external
        override
        returns (uint256 amountOutNet)
    {
        require(access.isApprovedSupplicator(msg.sender), "not permitted");

        address payer = p.payer == address(0) ? msg.sender : p.payer;
        address to    = p.to    == address(0) ? msg.sender : p.to;

        // Route pool’s output to router so we can take fees
        uint256 grossOut = ILPPPool(p.pool).supplicate(
            payer,
            address(this),
            p.assetToUsdc,
            p.amountIn,
            p.minAmountOut
        );

        address tokenOut = p.assetToUsdc ? ILPPPool(p.pool).usdc() : ILPPPool(p.pool).asset();
        amountOutNet = _skimAndDistributeFees_OutputSide(p.pool, tokenOut, grossOut);

        // Send net to recipient
        IERC20(tokenOut).transfer(to, amountOutNet);

        // Optional bookkeeping event in ILPPRouter
        address tokenIn = p.assetToUsdc ? ILPPPool(p.pool).asset() : ILPPPool(p.pool).usdc();
        emit SupplicateExecuted(msg.sender, p.pool, tokenIn, p.amountIn, tokenOut, amountOutNet, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // 3-hop MCV orbit (fee per hop, no internal profit accounting here)
    // ─────────────────────────────────────────────────────────────────────────────

    function mcvSupplication(MCVParams calldata params)
        external
        override
        returns (uint256 finalAmountOut)
    {
        require(params.amountIn > 0, "zero input");
        OrbitConfig memory cfg = _orbitOf[params.startPool];
        require(cfg.initialized, "orbit: not configured");

        address[3] memory orbit = cfg.pools;

        bool dir = params.assetToUsdc;
        uint256 amount = params.amountIn;
        address payer  = params.payer == address(0) ? msg.sender : params.payer;
        address to     = params.to    == address(0) ? msg.sender : params.to;

        // hop 0: payer -> pool0 -> router
        amount = _executeHopWithFees(orbit[0], dir, amount, payer);

        // hop 1: router -> pool1 -> router (flip)
        dir = !dir;
        amount = _executeHopWithFees(orbit[1], dir, amount, address(this));

        // hop 2: router -> pool2 -> router (flip)
        dir = !dir;
        amount = _executeHopWithFees(orbit[2], dir, amount, address(this));

        finalAmountOut = amount;

        // last hop’s output token (depends on dir after flip)
        address endToken = dir ? ILPPPool(orbit[2]).usdc() : ILPPPool(orbit[2]).asset();
        IERC20(endToken).transfer(to, finalAmountOut);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // internals
    // ─────────────────────────────────────────────────────────────────────────────

    function _executeHopWithFees(
        address pool,
        bool assetToUsdc,
        uint256 amountIn,
        address payer
    ) internal returns (uint256 netOut) {
        require(pool != address(0), "zero pool");
        require(amountIn > 0, "zero hop amount");

        address tokenIn  = assetToUsdc ? ILPPPool(pool).asset() : ILPPPool(pool).usdc();
        address tokenOut = assetToUsdc ? ILPPPool(pool).usdc()  : ILPPPool(pool).asset();

        if (payer == address(this)) {
            IERC20(tokenIn).approve(pool, amountIn);
        }

        uint256 grossOut = ILPPPool(pool).supplicate(
            payer,
            address(this),
            assetToUsdc,
            amountIn,
            0
        );

        netOut = _skimAndDistributeFees_OutputSide(pool, tokenOut, grossOut);
        // router now holds netOut of tokenOut for the next hop
    }

    /// @dev Fee-on-output model:
    ///  - We hold `grossOut` tokens at the router.
    ///  - We send `treasuryFt` to the treasury.
    ///  - We **transfer `poolsFt` to the pool, then call donateToReserves(...)**
    ///    so accounting reserves increase (no LP minted).
    ///  - Return net to continue or to the final recipient.
    function _skimAndDistributeFees_OutputSide(
        address pool,
        address tokenOut,
        uint256 grossOut
    ) internal returns (uint256 netOut) {
        if (grossOut == 0) return 0;

        uint256 totalFee   = (grossOut * MCV_FEE_BPS) / BPS_DENOMINATOR;      // 2.5%
        uint256 treasuryFt = (grossOut * TREASURY_CUT_BPS) / BPS_DENOMINATOR; // 0.5%
        uint256 poolsFt    = totalFee - treasuryFt;                            // 2.0%

        // Pay treasury from router balance
        if (treasuryFt > 0) IERC20(tokenOut).transfer(treasury, treasuryFt);

        // Move pools cut to the pool, then reconcile reserves via donateToReserves
        if (poolsFt > 0) {
            IERC20(tokenOut).transfer(pool, poolsFt);
            bool isUsdc = (tokenOut == ILPPPool(pool).usdc());
            ILPPPool(pool).donateToReserves(isUsdc, poolsFt);
        }

        emit FeeTaken(pool, tokenOut, grossOut, totalFee, treasuryFt, poolsFt);

        netOut = grossOut - totalFee;
    }
}