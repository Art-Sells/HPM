// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPRouter } from "./interfaces/ILPPRouter.sol";
import { ILPPAccessManager } from "./interfaces/ILPPAccessManager.sol";
import { ILPPPool } from "./interfaces/ILPPPool.sol";
import { IERC20 } from "./external/IERC20.sol";

interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external;
}

/**
 * @title LPPRouter
 * @notice Router for single-hop supplication and 3-hop MCV supplication.
 *
 * Direction policy (dual-orbit):
 *   - NEG set  => ASSET -> USDC (assetToUsdc = true)
 *   - POS set  => USDC -> ASSET (assetToUsdc = false)
 *
 * After each successful MCV call, the active set flips (NEG<->POS).
 * Direction is derived from the active set; no independent direction cursor is stored.
 *
 * NOTE: This version removes the separate `useAssetToUsdcNext` boolean from DualOrbit storage.
 *       Treat as a breaking storage change for already-deployed contracts.
 */
contract LPPRouter is ILPPRouter {
    ILPPAccessManager public immutable access;
    address public immutable treasury;

    // -------- Fee constants (UNCHANGED economics) --------
    uint16 public constant override BPS_DENOMINATOR = 10_000;
    // Per-hop fee: 12 bps (0.12%) charged on each hop (3 hops/event => 36 bps/event)
    uint16 public constant override MCV_FEE_BPS      = 12; // 0.12% per hop
    // Split per hop: 2 bps (0.02%) to treasury, 10 bps (0.10%) to LPs
    uint16 public constant TREASURY_CUT_BPS          = 2;  // 0.02% of hop input
    uint16 public constant POOLS_CUT_BPS             = 10; // 0.10% of hop input

    // -------- Daily cap (NEW) --------
    uint32 public constant MAX_EVENTS_PER_DAY = 500; // hard ceiling for mcvSupplication calls per UTC day
    uint64 private _eventsDay;     // UTC day index (block.timestamp / 1 days)
    uint32 private _eventsCount;   // number of mcvSupplication calls today

    /// @dev Thrown when daily ceiling is reached.
    error MaxDailyEventsReached(uint64 day, uint256 count, uint256 limit);

    /// @dev Emitted when the daily window rolls (UTC).
    event DailyWindowRolled(uint64 indexed newDay);

    /// @dev Emitted on each accepted event after increment.
    event DailyEventCounted(uint64 indexed day, uint32 newCount);

    // -------- Orbit storage (legacy single-orbit kept) --------
    struct OrbitConfig { address[3] pools; bool initialized; }
    mapping(address => OrbitConfig) private _orbitOf; // legacy single orbit

    // Dual-orbit with set flip (direction derived from set)
    struct DualOrbit {
        address[3] neg;               // “-500” set
        address[3] pos;               // “+500” set
        bool useNegNext;              // flips every call (NEG <-> POS)
        bool initialized;
    }
    mapping(address => DualOrbit) private _dualOrbit;

    // Extra event ONLY defined here (not in interface) to expose direction as derived
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

        _eventsDay = _today(); // initialize day window
    }

    // ─────────────────────────────────────────────────────────────
    // Public views for monitoring the cap
    // ─────────────────────────────────────────────────────────────
    function todayDayIndex() public view returns (uint64) {
        return _today();
    }

    function eventsCountToday() public view returns (uint32) {
        (uint64 d, uint32 c) = _rolledCounterView();
        return d == _today() ? c : 0;
    }

    function remainingEventsToday() external view returns (uint256) {
        uint32 c = eventsCountToday();
        return (c >= MAX_EVENTS_PER_DAY) ? 0 : (MAX_EVENTS_PER_DAY - c);
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
    // Dual-orbit config (NEG: -500 set, POS: +500 set) + derived direction
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

        _dualOrbit[startPool] = DualOrbit({
            neg: neg,
            pos: pos,
            useNegNext: startWithNeg,
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

    /**
     * @notice Derived direction helper for monitoring:
     *         NEG => true (ASSET->USDC), POS => false (USDC->ASSET)
     */
    function getDirectionCursor(address startPool) external view returns (bool useAssetToUsdcNext) {
        DualOrbit memory d = _dualOrbit[startPool];
        require(d.initialized, "dual: not set");
        return d.useNegNext ? true : false;
    }

    /// Legacy API slot retained but intentionally disabled:
    function setDirectionCursorViaTreasury(address /*startPool*/, bool /*useAssetToUsdcNext_*/) external pure {
        revert("direction is derived from orbit");
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
    // NEW: Single-pool supplicate with EIP-2612 permits
    // ─────────────────────────────────────────────────────────────
    struct PermitData {
        address token;
        uint256 value;
        uint256 deadline;
        uint8   v;
        bytes32 r;
        bytes32 s;
    }

    function supplicateWithPermit(
        SupplicateParams calldata p,
        PermitData     calldata feePermit,       // allowance for router fees
        PermitData     calldata principalPermit  // allowance for pool principal
    ) external returns (uint256 amountOut /* gross */) {
        require(access.isApprovedSupplicator(msg.sender), "not permitted");

        address payer = p.payer == address(0) ? msg.sender : p.payer;
        address to    = p.to    == address(0) ? msg.sender : p.to;

        address tokenIn  = p.assetToUsdc ? ILPPPool(p.pool).asset() : ILPPPool(p.pool).usdc();
        address tokenOut = p.assetToUsdc ? ILPPPool(p.pool).usdc()  : ILPPPool(p.pool).asset();

        // --- EIP-2612 permits ---
        require(feePermit.token == tokenIn, "feePermit token mismatch");
        IERC20Permit(tokenIn).permit(
            payer, address(this),
            feePermit.value, feePermit.deadline,
            feePermit.v, feePermit.r, feePermit.s
        );

        require(principalPermit.token == tokenIn, "principalPermit token mismatch");
        IERC20Permit(tokenIn).permit(
            payer, p.pool,
            principalPermit.value, principalPermit.deadline,
            principalPermit.v, principalPermit.r, principalPermit.s
        );

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

        IERC20(tokenOut).transfer(to, amountOut);

        emit HopExecuted(p.pool, p.assetToUsdc, tokenIn, tokenOut, p.amountIn, amountOut);
        emit SupplicateExecuted(msg.sender, p.pool, tokenIn, p.amountIn, tokenOut, amountOut, 0);
    }

    // ─────────────────────────────────────────────────────────────
    // MCV: 3 independent hops, SAME INPUT TOKEN & AMOUNT per hop
    // ─────────────────────────────────────────────────────────────
    function mcvSupplication(MCVParams calldata params)
        external
        override
        returns (uint256 finalAmountOut)
    {
        require(params.amountIn > 0, "zero input");

        // Enforce daily ceiling BEFORE any stateful token ops
        _consumeEventSlotOrRevert();

        // Determine orbit set + derived direction
        address[3] memory orbit;
        bool assetToUsdc; // true = ASSET->USDC, false = USDC->ASSET

        if (_dualOrbit[params.startPool].initialized) {
            DualOrbit storage d = _dualOrbit[params.startPool];
            orbit = d.useNegNext ? d.neg : d.pos;
            // DERIVE: NEG => ASSET->USDC, POS => USDC->ASSET
            assetToUsdc = d.useNegNext ? true : false;
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

        // Flip set AFTER the call (only when dual-orbit is active)
        if (_dualOrbit[params.startPool].initialized) {
            DualOrbit storage d2 = _dualOrbit[params.startPool];
            d2.useNegNext = !d2.useNegNext; // set flip
            emit OrbitFlipped(params.startPool, d2.useNegNext);
            // Emit derived direction *after* flip
            bool newDir = d2.useNegNext ? true : false;
            emit DirectionFlipped(params.startPool, newDir);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // NEW: MCV with EIP-2612 permits
    // ─────────────────────────────────────────────────────────────

    function mcvSupplication(
        MCVParams calldata params,
        PermitData calldata feePermit,
        PermitData[3] calldata hopPermits
    ) external returns (uint256 finalAmountOut) {
        require(params.amountIn > 0, "zero input");

        // Enforce daily ceiling BEFORE any stateful ops
        _consumeEventSlotOrRevert();

        // Resolve active orbit + derived direction
        address[3] memory orbit;
        bool assetToUsdc;
        if (_dualOrbit[params.startPool].initialized) {
            DualOrbit storage d = _dualOrbit[params.startPool];
            orbit = d.useNegNext ? d.neg : d.pos;
            assetToUsdc = d.useNegNext ? true : false;
        } else {
            OrbitConfig memory cfg = _orbitOf[params.startPool];
            require(cfg.initialized, "orbit: not configured");
            orbit = cfg.pools;
            assetToUsdc = params.assetToUsdc;
        }

        address payer = params.payer == address(0) ? msg.sender : params.payer;
        address to    = params.to    == address(0) ? msg.sender : params.to;

        // Input token is the SAME across the 3 hops (pair-checked at config)
        address tokenIn = assetToUsdc ? ILPPPool(orbit[0]).asset() : ILPPPool(orbit[0]).usdc();

        // --- EIP-2612 permits ---
        // Router fee allowance
        require(feePermit.token == tokenIn, "feePermit token mismatch");
        IERC20Permit(tokenIn).permit(
            payer, address(this),
            feePermit.value, feePermit.deadline,
            feePermit.v, feePermit.r, feePermit.s
        );

        // Principal allowance per hop to each pool
        for (uint256 i = 0; i < 3; i++) {
            require(hopPermits[i].token == tokenIn, "hopPermit token mismatch");
            IERC20Permit(tokenIn).permit(
                payer, orbit[i],
                hopPermits[i].value, hopPermits[i].deadline,
                hopPermits[i].v, hopPermits[i].r, hopPermits[i].s
            );
        }

        // Execute 3 fee’d hops
        uint256 totalOut = 0;
        unchecked {
            for (uint256 i = 0; i < 3; i++) {
                totalOut += _executeIndependentHop(orbit[i], assetToUsdc, params.amountIn, payer, to);
            }
        }
        finalAmountOut = totalOut;

        // Flip set AFTER the call (dual-orbit only)
        DualOrbit storage d2 = _dualOrbit[params.startPool];
        if (d2.initialized) {
            d2.useNegNext = !d2.useNegNext;
            emit OrbitFlipped(params.startPool, d2.useNegNext);
            bool newDir = d2.useNegNext ? true : false;
            emit DirectionFlipped(params.startPool, newDir);
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

        uint256 totalFee   = (amountInBase * MCV_FEE_BPS) / BPS_DENOMINATOR;      // per-hop fee
        if (totalFee == 0) return;

        uint256 treasuryFt = (amountInBase * TREASURY_CUT_BPS) / BPS_DENOMINATOR; // treasury slice (bps of input)
        uint256 poolsFt    = totalFee - treasuryFt;                               // LP slice

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

    // ─────────────────────────────────────────────────────────────
    // Daily cap helpers
    // ─────────────────────────────────────────────────────────────
    function _today() private view returns (uint64) {
        return uint64(block.timestamp / 1 days); // UTC day index
    }

    function _rolledCounterView() private view returns (uint64 day, uint32 count) {
        uint64 t = _today();
        if (t == _eventsDay) {
            return (_eventsDay, _eventsCount);
        }
        // If the stored day is stale, view returns (t, 0) as effective count
        return (t, 0);
    }

    function _consumeEventSlotOrRevert() private {
        uint64 t = _today();
        if (t != _eventsDay) {
            _eventsDay = t;
            _eventsCount = 0;
            emit DailyWindowRolled(t);
        }
        if (_eventsCount >= MAX_EVENTS_PER_DAY) {
            revert MaxDailyEventsReached(_eventsDay, _eventsCount, MAX_EVENTS_PER_DAY);
        }
        unchecked {
            _eventsCount += 1;
        }
        emit DailyEventCounted(_eventsDay, _eventsCount);
    }
}