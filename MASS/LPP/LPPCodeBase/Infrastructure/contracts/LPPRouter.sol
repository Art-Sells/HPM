// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPRouter } from "./interfaces/ILPPRouter.sol";
import { ILPPAccessManager } from "./interfaces/ILPPAccessManager.sol";
import { ILPPPool } from "./interfaces/ILPPPool.sol";
import { IERC20 } from "./external/IERC20.sol";

contract LPPRouter is ILPPRouter {
    ILPPAccessManager public immutable access;
    address public immutable treasury;

    uint16 public constant override BPS_DENOMINATOR = 10_000;
    uint16 public constant override MCV_FEE_BPS      = 250; // 2.5% of profit

    // Phase-0 split: 0.5% to Treasury, 2.0% reserved for pools
    uint16 public constant TREASURY_CUT_BPS = 50;  // 0.5%
    uint16 public constant POOLS_CUT_BPS    = 200; // 2.0%
    // TREASURY_CUT_BPS + POOLS_CUT_BPS MUST == MCV_FEE_BPS

    struct OrbitConfig {
        address[3] pools;
        bool initialized;
    }

    // startPool => 3-pool orbit
    mapping(address => OrbitConfig) private _orbitOf;

    // -----------------------------------------------------------------------
    // Modifiers
    // -----------------------------------------------------------------------

    modifier onlyTreasury() {
        require(msg.sender == treasury, "not treasury");
        _;
    }

    constructor(address accessManager, address treasury_) {
        require(accessManager != address(0), "zero access");
        require(treasury_ != address(0), "zero treasury");
        require(TREASURY_CUT_BPS + POOLS_CUT_BPS == MCV_FEE_BPS, "bad fee split");

        access = ILPPAccessManager(accessManager);
        treasury = treasury_;
    }

    // -----------------------------------------------------------------------
    // Orbit configuration (Phase 0)
    // -----------------------------------------------------------------------

    /// @notice Configure a 3-pool orbit for a given starting pool.
    ///         Treasury will call this once per Phase-0 ladder slot.
    function setOrbit(address startPool, address[3] calldata pools_) external onlyTreasury {
        require(startPool != address(0), "orbit: zero start");
        require(pools_[0] != address(0) && pools_[1] != address(0) && pools_[2] != address(0), "orbit: zero pool");

        _orbitOf[startPool] = OrbitConfig({ pools: pools_, initialized: true });
        emit OrbitUpdated(startPool, pools_);
    }

    /// @notice View helper for tests / MEV off-chain code.
    function getOrbit(address startPool) external view returns (address[3] memory pools) {
        OrbitConfig memory cfg = _orbitOf[startPool];
        require(cfg.initialized, "orbit: not set");
        return cfg.pools;
    }

    // -----------------------------------------------------------------------
    // Single-pool supplicate (Treasury-approved only)
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // 3-pool orbit MCV-style supplication (anyone)
    // -----------------------------------------------------------------------

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

        OrbitConfig memory cfg = _orbitOf[params.startPool];
        require(cfg.initialized, "orbit: not configured");

        address[3] memory orbit = cfg.pools;

        bool dir = params.assetToUsdc;
        uint256 amount = params.amountIn;

        address payer = params.payer == address(0) ? msg.sender : params.payer;
        address to    = params.to    == address(0) ? msg.sender : params.to;

        // Determine starting token from first hop
        address startToken = dir
            ? ILPPPool(orbit[0]).asset()
            : ILPPPool(orbit[0]).usdc();

        // --------------------------------------------------------------------
        // Hop 0: payer -> pool[0] -> router
        // --------------------------------------------------------------------
        amount = _executeHopInternal(orbit[0], dir, amount, payer, address(this));

        // --------------------------------------------------------------------
        // Hop 1: router -> pool[1] -> router (flip direction)
        // --------------------------------------------------------------------
        dir = !dir;
        amount = _executeHopInternal(orbit[1], dir, amount, address(this), address(this));

        // --------------------------------------------------------------------
        // Hop 2: router -> pool[2] -> router (flip direction)
        // --------------------------------------------------------------------
        dir = !dir;
        amount = _executeHopInternal(orbit[2], dir, amount, address(this), address(this));

        finalAmountOut = amount;

        // Profit in starting token
        if (finalAmountOut > params.amountIn) {
            grossProfit = finalAmountOut - params.amountIn;
        } else {
            grossProfit = 0;
        }

        // Require strictly positive profit and meet minProfit
        require(grossProfit >= params.minProfit && grossProfit > 0, "no profit");

        // --------------------------------------------------------------------
        // Fee on profit (2.5% total)
        // --------------------------------------------------------------------
        fee = (grossProfit * MCV_FEE_BPS) / BPS_DENOMINATOR;

        // Split: 0.5% to Treasury, 2.0% reserved for pools
        treasuryCut = (grossProfit * TREASURY_CUT_BPS) / BPS_DENOMINATOR;
        uint256 poolsCut = fee - treasuryCut; // currently just accumulated on router

        // Pay Treasury first
        if (treasuryCut > 0) {
            IERC20(startToken).transfer(treasury, treasuryCut);
        }

        // (Phase 0) poolsCut stays on router; later you can wire it
        // into LPPPool via a dedicated donate/fee hook.

        // Net to MEV wallet
        uint256 netToUser = finalAmountOut - fee;
        IERC20(startToken).transfer(to, netToUser);

        // Silence unused warning for poolsCut (for now)
        poolsCut; // no-op
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    function _executeHopInternal(
        address pool,
        bool assetToUsdc,
        uint256 amountIn,
        address payer,
        address recipient
    ) internal returns (uint256 amountOut) {
        require(pool != address(0), "zero pool");
        require(amountIn > 0, "zero hop amount");

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
            0 // local minOut; global minProfit handled in router
        );
    }
}