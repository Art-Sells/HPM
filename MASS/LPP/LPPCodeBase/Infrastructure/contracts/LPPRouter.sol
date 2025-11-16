// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPRouter } from "./interfaces/ILPPRouter.sol";
import { ILPPAccessManager } from "./interfaces/ILPPAccessManager.sol";
import { ILPPPool } from "./interfaces/ILPPPool.sol";
import { IERC20 } from "./external/IERC20.sol";

contract LPPRouter is ILPPRouter {
    ILPPAccessManager public immutable access;
    address public immutable treasury;

    // ILPPRouter constants
    uint16 public constant override BPS_DENOMINATOR = 10_000;
    uint16 public constant override MCV_FEE_BPS      = 250; // 2.5%
    uint16 public constant TREASURY_CUT_BPS          = 50;  // 0.5% (of input)
    uint16 public constant POOLS_CUT_BPS             = 200; // 2.0% (of input)

    struct OrbitConfig { address[3] pools; bool initialized; }
    mapping(address => OrbitConfig) private _orbitOf;

    event FeeTaken(
        address indexed pool,
        address indexed token,      // fee token (input token of hop)
        uint256 amountBase,         // hop amountIn on which fee was computed
        uint256 totalFee,           // 2.5%
        uint256 treasuryFee,        // 0.5%
        uint256 poolsFee            // 2.0%
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

    // ─────────────────────────────────────────────────────────────
    // Orbit config
    // ─────────────────────────────────────────────────────────────

    function setOrbit(address startPool, address[3] calldata pools_) external onlyTreasury {
        require(startPool != address(0), "orbit: zero start");
        require(
            pools_[0] != address(0) && pools_[1] != address(0) && pools_[2] != address(0),
            "orbit: zero pool"
        );

        // Enforce same pair across all three pools
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

    // ─────────────────────────────────────────────────────────────
    // Single-pool supplicate (approved-only) — FEE ON INPUT
    // ─────────────────────────────────────────────────────────────

    function supplicate(SupplicateParams calldata p)
        external
        override
        returns (uint256 amountOut /* gross */)
    {
        require(access.isApprovedSupplicator(msg.sender), "not permitted");

        address payer = p.payer == address(0) ? msg.sender : p.payer;
        address to    = p.to    == address(0) ? msg.sender : p.to;

        // Take fee on INPUT token first (from external payer)
        address tokenIn = p.assetToUsdc ? ILPPPool(p.pool).asset() : ILPPPool(p.pool).usdc();
        _takeInputFeeAndDonate(p.pool, tokenIn, payer, p.amountIn, /*payerIsRouter*/ false);

        // Execute swap: pool pulls `amountIn` from payer, sends GROSS out to router
        amountOut = ILPPPool(p.pool).supplicate(
            payer,
            address(this),
            p.assetToUsdc,
            p.amountIn,
            p.minAmountOut
        );

        // Pass GROSS through to recipient (no output skim)
        address tokenOut = p.assetToUsdc ? ILPPPool(p.pool).usdc() : ILPPPool(p.pool).asset();
        IERC20(tokenOut).transfer(to, amountOut);

        emit SupplicateExecuted(msg.sender, p.pool, tokenIn, p.amountIn, tokenOut, amountOut, 0);
    }

    // ─────────────────────────────────────────────────────────────
    // 3-hop MCV orbit — fee on hop-0 input only (external payer)
    // ─────────────────────────────────────────────────────────────

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

        // hop 0 (external payer): fee on input
        amount = _executeHop_InputFeeThenSwap(orbit[0], dir, amount, payer, /*chargeInputFee*/ true);

        // hop 1 (router payer): skip input fee for now (to avoid starving amount mid-orbit)
        dir = !dir;
        amount = _executeHop_InputFeeThenSwap(orbit[1], dir, amount, address(this), /*chargeInputFee*/ false);

        // hop 2 (router payer): skip input fee for now
        dir = !dir;
        amount = _executeHop_InputFeeThenSwap(orbit[2], dir, amount, address(this), /*chargeInputFee*/ false);

        finalAmountOut = amount;

        // deliver final tokens
        address endToken = dir ? ILPPPool(orbit[2]).usdc() : ILPPPool(orbit[2]).asset();
        IERC20(endToken).transfer(to, finalAmountOut);
    }

    // ─────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────

    function _executeHop_InputFeeThenSwap(
        address pool,
        bool assetToUsdc,
        uint256 amountIn,
        address payer,
        bool chargeInputFee
    ) internal returns (uint256 grossOut) {
        require(pool != address(0), "zero pool");
        require(amountIn > 0, "zero hop amount");

        address tokenIn = assetToUsdc ? ILPPPool(pool).asset() : ILPPPool(pool).usdc();

        if (chargeInputFee) {
            // external payer (not the router)
            _takeInputFeeAndDonate(pool, tokenIn, payer, amountIn, /*payerIsRouter*/ false);
        }

        // If router is the payer, ensure approval for pull
        if (payer == address(this)) {
            IERC20(tokenIn).approve(pool, amountIn);
        }

        grossOut = ILPPPool(pool).supplicate(
            payer,
            address(this),
            assetToUsdc,
            amountIn,
            0
        );
        // No output skim; returned amount becomes next hop's input
    }

    /// @dev Pull fee on INPUT token, split treasury/pools, credit pools via donateToReserves.
    function _takeInputFeeAndDonate(
        address pool,
        address tokenIn,
        address payer,
        uint256 amountInBase,
        bool payerIsRouter
    ) internal {
        if (MCV_FEE_BPS == 0) return;

        uint256 totalFee   = (amountInBase * MCV_FEE_BPS) / BPS_DENOMINATOR;      // 2.5%
        if (totalFee == 0) return;

        uint256 treasuryFt = (amountInBase * TREASURY_CUT_BPS) / BPS_DENOMINATOR; // 0.5%
        uint256 poolsFt    = totalFee - treasuryFt;                                // 2.0%

        // Source the fee
        if (payerIsRouter) {
            // Not used in current flow (we skip inter-hop fees). Left for future pre-funded path.
            // If enabled later: ensure router holds tokenIn >= amountInBase + totalFee, then:
            // IERC20(tokenIn).transfer(treasury, treasuryFt); IERC20(tokenIn).transfer(pool, poolsFt);
        } else {
            // Pull from external payer
            IERC20(tokenIn).transferFrom(payer, address(this), totalFee);
            if (treasuryFt > 0) IERC20(tokenIn).transfer(treasury, treasuryFt);
            if (poolsFt > 0) {
                IERC20(tokenIn).transfer(pool, poolsFt);
                bool isUsdc = (tokenIn == ILPPPool(pool).usdc());
                ILPPPool(pool).donateToReserves(isUsdc, poolsFt);
            }
        }

        emit FeeTaken(pool, tokenIn, amountInBase, totalFee, treasuryFt, poolsFt);
    }
}