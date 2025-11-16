// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPRouter } from "./interfaces/ILPPRouter.sol";
import { ILPPAccessManager } from "./interfaces/ILPPAccessManager.sol";
import { ILPPPool } from "./interfaces/ILPPPool.sol";
import { IERC20 } from "./external/IERC20.sol";

contract LPPRouter is ILPPRouter {
    ILPPAccessManager public immutable access;
    address public immutable treasury;

    // -------- Fee constants --------
    uint16 public constant override BPS_DENOMINATOR = 10_000;
    // Per-hop input fee (applied on each of the 3 hops for MCV)
    uint16 public constant override MCV_FEE_BPS      = 250; // 2.5%
    uint16 public constant TREASURY_CUT_BPS          = 50;  // 0.5% of input (part of 2.5%)
    uint16 public constant POOLS_CUT_BPS             = 200; // 2.0% of input (part of 2.5%)

    // -------- Orbit storage (legacy single-orbit kept) --------
    struct OrbitConfig { address[3] pools; bool initialized; }
    mapping(address => OrbitConfig) private _orbitOf; // legacy single orbit

    // Dual-orbit with cursors (set flip; internal direction flip across calls)
    struct DualOrbit {
        address[3] neg;               // “-500” set
        address[3] pos;               // “+500” set
        bool useNegNext;              // flips every call
        bool useAssetToUsdcNext;      // flips every call (ASSET-in ↔ USDC-in)
        bool initialized;
    }
    mapping(address => DualOrbit) private _dualOrbit;

    // Extra event ONLY defined here (not in interface) to expose direction cursor changes
    event DirectionFlipped(address indexed startPool, bool useAssetToUsdcNow);

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
    // Orbit config (legacy; kept for back-compat)
    // ─────────────────────────────────────────────────────────────
    function setOrbit(address startPool, address[3] calldata pools_) external onlyTreasury {
        require(startPool != address(0), "orbit: zero start");
        require(pools_[0] != address(0) && pools_[1] != address(0) && pools_[2] != address(0), "orbit: zero pool");

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
    // Dual-orbit config (NEG: -500 set, POS: +500 set) + cursors
    // ─────────────────────────────────────────────────────────────
    function setDualOrbit(
        address startPool,
        address[3] calldata neg,
        address[3] calldata pos,
        bool startWithNeg
    ) external onlyTreasury {
        require(startPool != address(0), "dual: zero start");

        for (uint256 i = 0; i < 3; i++) {
            require(neg[i] != address(0) && pos[i] != address(0), "dual: zero pool");
        }

        address a0 = ILPPPool(neg[0]).asset();
        address u0 = ILPPPool(neg[0]).usdc();
        for (uint256 i = 1; i < 3; i++) {
            require(ILPPPool(neg[i]).asset() == a0 && ILPPPool(neg[i]).usdc() == u0, "dual: NEG pair mismatch");
            require(ILPPPool(pos[i]).asset() == a0 && ILPPPool(pos[i]).usdc() == u0, "dual: POS pair mismatch");
        }
        require(ILPPPool(pos[0]).asset() == a0 && ILPPPool(pos[0]).usdc() == u0, "dual: POS pair mismatch");

        // Start direction cursor at USDC-in (false = USDC->ASSET) for first call; you can change this later.
        _dualOrbit[startPool] = DualOrbit({
            neg: neg,
            pos: pos,
            useNegNext: startWithNeg,
            useAssetToUsdcNext: false,
            initialized: true
        });

        emit DualOrbitUpdated(startPool, neg, pos, startWithNeg);
    }

    function getActiveOrbit(address startPool)
        external
        view
        returns (address[3] memory orbit, bool usingNeg)
    {
        DualOrbit memory d = _dualOrbit[startPool];
        require(d.initialized, "dual: not set");
        orbit = d.useNegNext ? d.neg : d.pos;
        usingNeg = d.useNegNext;
    }

    // NOTE: matches interface signature (3 returns)
    function getDualOrbit(address startPool)
        external
        view
        returns (address[3] memory neg, address[3] memory pos, bool usingNeg)
    {
        DualOrbit memory d = _dualOrbit[startPool];
        require(d.initialized, "dual: not set");
        return (d.neg, d.pos, d.useNegNext);
    }

    // Optional helper to read direction cursor (not in interface)
    function getDirectionCursor(address startPool) external view returns (bool useAssetToUsdcNext) {
        DualOrbit memory d = _dualOrbit[startPool];
        require(d.initialized, "dual: not set");
        return d.useAssetToUsdcNext;
    }

    /// Optional: treasury can seed/tweak the next-direction cursor.
    function setDirectionCursorViaTreasury(address startPool, bool useAssetToUsdcNext_) external onlyTreasury {
        DualOrbit storage d = _dualOrbit[startPool];
        require(d.initialized, "dual: not set");
        d.useAssetToUsdcNext = useAssetToUsdcNext_;
        emit DirectionFlipped(startPool, d.useAssetToUsdcNext);
    }

    // ─────────────────────────────────────────────────────────────
    // Single-pool supplicate (approved-only) — fee on input (always)
    // ─────────────────────────────────────────────────────────────
    function supplicate(SupplicateParams calldata p)
        external
        override
        returns (uint256 amountOut /* gross */)
    {
        require(access.isApprovedSupplicator(msg.sender), "not permitted");

        address payer = p.payer == address(0) ? msg.sender : p.payer;
        address to    = p.to    == address(0) ? msg.sender : p.to;

        address tokenIn  = p.assetToUsdc ? ILPPPool(p.pool).asset() : ILPPPool(p.pool).usdc();
        address tokenOut = p.assetToUsdc ? ILPPPool(p.pool).usdc()  : ILPPPool(p.pool).asset();

        // Per-hop input fee (same policy as MCV)
        _takeInputFeeAndDonate(p.pool, tokenIn, payer, p.amountIn);

        // Execute swap: pool pulls amountIn from payer; sends gross to router
        amountOut = ILPPPool(p.pool).supplicate(
            payer,
            address(this),
            p.assetToUsdc,
            p.amountIn,
            p.minAmountOut
        );

        // Passthrough (no skim)
        IERC20(tokenOut).transfer(to, amountOut);

        emit HopExecuted(p.pool, p.assetToUsdc, tokenIn, tokenOut, p.amountIn, amountOut);
        emit SupplicateExecuted(msg.sender, p.pool, tokenIn, p.amountIn, tokenOut, amountOut, 0);
    }

    // ─────────────────────────────────────────────────────────────
    // MCV: 3 independent hops, SAME INPUT TOKEN & AMOUNT per hop
    //      - Applies input fee on EACH hop (payer is external for all hops)
    //      - Flips NEG↔POS set and USDC-in↔ASSET-in direction AFTER each call
    // ─────────────────────────────────────────────────────────────
    function mcvSupplication(MCVParams calldata params)
        external
        override
        returns (uint256 finalAmountOut)
    {
        require(params.amountIn > 0, "zero input");

        // Determine orbit set + direction via cursors (TL;DR policy)
        address[3] memory orbit;
        bool assetToUsdc; // true = ASSET->USDC (ASSET-in), false = USDC->ASSET (USDC-in)

        if (_dualOrbit[params.startPool].initialized) {
            DualOrbit storage d = _dualOrbit[params.startPool];
            orbit = d.useNegNext ? d.neg : d.pos;
            assetToUsdc = d.useAssetToUsdcNext;
        } else {
            // Fallback legacy single-orbit (no flipping baked in)
            OrbitConfig memory cfg = _orbitOf[params.startPool];
            require(cfg.initialized, "orbit: not configured");
            orbit = cfg.pools;
            assetToUsdc = params.assetToUsdc; // honor param in legacy mode
        }

        address payer = params.payer == address(0) ? msg.sender : params.payer;
        address to    = params.to    == address(0) ? msg.sender : params.to;

        uint256 totalOut = 0;
        unchecked {
            for (uint256 i = 0; i < 3; i++) {
                uint256 outI = _executeIndependentHop(orbit[i], assetToUsdc, params.amountIn, payer, to);
                totalOut += outI;
            }
        }

        finalAmountOut = totalOut;

        // Flip cursors AFTER the call (only when dual-orbit is active)
        if (_dualOrbit[params.startPool].initialized) {
            DualOrbit storage d2 = _dualOrbit[params.startPool];
            d2.useNegNext = !d2.useNegNext;                 // set flip
            d2.useAssetToUsdcNext = !d2.useAssetToUsdcNext; // direction alternation
            emit OrbitFlipped(params.startPool, d2.useNegNext);
            emit DirectionFlipped(params.startPool, d2.useAssetToUsdcNext);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────
    function _executeIndependentHop(
        address pool,
        bool assetToUsdc,
        uint256 amountIn,
        address payer,
        address to
    ) internal returns (uint256 grossOut) {
        require(pool != address(0), "zero pool");
        require(amountIn > 0, "zero hop amount");

        address tokenIn  = assetToUsdc ? ILPPPool(pool).asset() : ILPPPool(pool).usdc();
        address tokenOut = assetToUsdc ? ILPPPool(pool).usdc()  : ILPPPool(pool).asset();

        // Per-hop fee (payer → router → treasury + donate to pool input reserve)
        _takeInputFeeAndDonate(pool, tokenIn, payer, amountIn);

        // Let pool pull amountIn from payer and return gross out to router
        grossOut = ILPPPool(pool).supplicate(
            payer,
            address(this),
            assetToUsdc,
            amountIn,
            0
        );

        // Forward to recipient immediately
        IERC20(tokenOut).transfer(to, grossOut);

        emit HopExecuted(pool, assetToUsdc, tokenIn, tokenOut, amountIn, grossOut);
    }

    /// @dev Pull fee on INPUT token from `payer`, split to treasury & pool (donated to input-side reserves).
    function _takeInputFeeAndDonate(
        address pool,
        address tokenIn,
        address payer,
        uint256 amountInBase
    ) internal {
        if (MCV_FEE_BPS == 0) return;

        uint256 totalFee   = (amountInBase * MCV_FEE_BPS) / BPS_DENOMINATOR;      // 2.5%
        if (totalFee == 0) return;

        uint256 treasuryFt = (amountInBase * TREASURY_CUT_BPS) / BPS_DENOMINATOR; // 0.5%
        uint256 poolsFt    = totalFee - treasuryFt;                               // 2.0%

        // Pull fee from payer
        IERC20(tokenIn).transferFrom(payer, address(this), totalFee);

        // Pay treasury slice
        if (treasuryFt > 0) IERC20(tokenIn).transfer(treasury, treasuryFt);

        // Donate the pools slice to the *input* side of this hop's pool
        if (poolsFt > 0) {
            IERC20(tokenIn).transfer(pool, poolsFt);
            bool isUsdc = (tokenIn == ILPPPool(pool).usdc());
            ILPPPool(pool).donateToReserves(isUsdc, poolsFt);
        }

        emit FeeTaken(pool, tokenIn, amountInBase, totalFee, treasuryFt, poolsFt);
    }
}