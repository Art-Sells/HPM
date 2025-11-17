// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPRouter } from "./interfaces/ILPPRouter.sol";
import { ILPPAccessManager } from "./interfaces/ILPPAccessManager.sol";
import { ILPPPool } from "./interfaces/ILPPPool.sol";
import { IERC20 } from "./external/IERC20.sol";

interface IERC20Permit {
    function permit(
        address owner, address spender, uint256 value, uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external;
}

/* -------- Minimal Permit2 interface (single-spender, single-token) -------- */
interface IPermit2 {
    struct TokenPermissions { address token; uint256 amount; }
    struct PermitSingle {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
        address spender;
        // NOTE: selector uses (owner, PermitSingle, bytes) for signature
    }
    function permit(address owner, PermitSingle calldata permitSingle, bytes calldata sig) external;
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

/* -------- Optional MCV post-exec callback -------- */
interface IMCVCallback {
    function onAfterMCV(
        address caller,
        address tokenIn,
        address tokenOut,
        uint256 amountInPerHop,
        uint256 totalAmountOut,
        bytes calldata data
    ) external;
}

contract LPPRouter is ILPPRouter {
    ILPPAccessManager public immutable access;
    address public immutable treasury;

    /* -------- Fees -------- */
    uint16 public constant override BPS_DENOMINATOR = 10_000;
    uint16 public constant override MCV_FEE_BPS      = 12; // 0.12% per hop
    uint16 public constant TREASURY_CUT_BPS          = 2;  // 0.02% of hop input
    uint16 public constant POOLS_CUT_BPS             = 10; // 0.10% of hop input

    /* -------- Daily cap -------- */
    uint32 public constant MAX_EVENTS_PER_DAY = 500;
    uint64 private _eventsDay;
    uint32 private _eventsCount;

    /* -------- MEV-friendly custom errors (16) -------- */
    error MaxDailyEventsReached(uint64 day, uint256 count, uint256 limit);
    error OrbitNotSet(address startPool);
    error Slippage(uint256 got, uint256 minRequired);

    event DailyWindowRolled(uint64 indexed newDay);
    event DailyEventCounted(uint64 indexed day, uint32 newCount);
    event DirectionFlipped(address indexed startPool, bool useAssetToUsdcNow);

    /* -------- Orbit storage -------- */
    struct OrbitConfig { address[3] pools; bool initialized; }
    mapping(address => OrbitConfig) private _orbitOf;

    struct DualOrbit {
        address[3] neg;
        address[3] pos;
        bool useNegNext;    // flips every call
        bool initialized;
    }
    mapping(address => DualOrbit) private _dualOrbit;

    modifier onlyTreasury() {
        require(msg.sender == treasury, "not treasury");
        _;
    }

    constructor(address accessManager, address treasury_) {
        require(accessManager != address(0), "zero access");
        require(treasury_ != address(0), "zero treasury");
        access = ILPPAccessManager(accessManager);
        treasury = treasury_;
        _eventsDay = _today();
    }

    /* ───────────────────────────────────────────
       New structs: aggregate minOut + Permit2
       ─────────────────────────────────────────── */

    struct Permit2Data {
        address permit2;   // Permit2 contract
        address owner;     // token owner (payer)
        uint256 amount;    // allowance upper bound (should cover 3*amountIn + 3*fee)
        uint256 nonce;
        uint256 deadline;
        bytes   signature; // EIP-712 sig for Permit2.permit
    }

    /* ───────────────────────────────────────────
       Public views for the daily cap
       ─────────────────────────────────────────── */
    function todayDayIndex() public view returns (uint64) { return _today(); }

    function eventsCountToday() public view returns (uint32) {
        (uint64 d, uint32 c) = _rolledCounterView();
        return d == _today() ? c : 0;
    }

    function remainingEventsToday() external view returns (uint256) {
        uint32 c = eventsCountToday();
        return (c >= MAX_EVENTS_PER_DAY) ? 0 : (MAX_EVENTS_PER_DAY - c);
    }

    /* ───────────────────────────────────────────
       Orbit config (legacy + dual)
       ─────────────────────────────────────────── */
    function setOrbit(address startPool, address[3] calldata pools_) external onlyTreasury {
        require(startPool != address(0), "orbit: zero start");
        require(pools_[0] != address(0) && pools_[1] != address(0) && pools_[2] != address(0), "orbit: zero pool");
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
            require(ILPPPool(neg[i]).asset() == a0 && ILPPPool(neg[i]).usdc() == u0, "dual: NEG mismatch");
            require(ILPPPool(pos[i]).asset() == a0 && ILPPPool(pos[i]).usdc() == u0, "dual: POS mismatch");
        }
        require(ILPPPool(pos[0]).asset() == a0 && ILPPPool(pos[0]).usdc() == u0, "dual: POS mismatch");

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
        return (d.useNegNext ? d.neg : d.pos, d.useNegNext);
    }

    function getDualOrbit(address startPool)
        external
        view
        returns (address[3] memory neg, address[3] memory pos, bool usingNeg)
    {
        DualOrbit memory d = _dualOrbit[startPool];
        require(d.initialized, "dual: not set");
        return (d.neg, d.pos, d.useNegNext);
    }

    function getDirectionCursor(address startPool) external view returns (bool useAssetToUsdcNext) {
        DualOrbit memory d = _dualOrbit[startPool];
        require(d.initialized, "dual: not set");
        return d.useNegNext ? true : false;
    }

    function setDirectionCursorViaTreasury(address, bool) external pure {
        revert("direction is derived from orbit");
    }

    /* ───────────────────────────────────────────
       Bundle-friendly surfaces (3)
       ─────────────────────────────────────────── */

    /// @notice (3) Return ABI-encoded calldata for mcvSupplication(params)
    function buildMCVCalldata(
        MCVParams calldata p
    ) external view returns (
        bytes memory data,
        address[3] memory orbit,
        bool assetToUsdc,
        address tokenIn,
        address tokenOut
    ) {
        (orbit, assetToUsdc, tokenIn, tokenOut) = _resolveOrbitAndTokens(p.startPool, p.assetToUsdc);

        // Avoid overload ambiguity by using the explicit selector for the base overload:
        // mcvSupplication((address,bool,uint256,address,address,uint256))
        bytes4 selBase = bytes4(
            keccak256("mcvSupplication((address,bool,uint256,address,address,uint256))")
        );
        data = abi.encodeWithSelector(selBase, p);
    }

    /// @notice (3) Execute MCV then call back into `callback` with context data.
    function mcvSupplicationAndCallback(
        MCVParams calldata params,
        address callback,
        bytes calldata context
    ) external returns (uint256 finalAmountOut) {
        // Resolve tokens before execution (view-only)
        (, , address tokenIn_, address tokenOut_) =
            _resolveOrbitAndTokens(params.startPool, params.assetToUsdc);

        // Execute core
        finalAmountOut = _mcvCore(
            params,
            /*usePermit2=*/false,
            Permit2Data({
                permit2: address(0),
                owner: address(0),
                amount: 0,
                nonce: 0,
                deadline: 0,
                signature: ""
            })
        );

        // Post-exec callback for bundlers / searchers
        IMCVCallback(callback).onAfterMCV(
            msg.sender,
            tokenIn_,
            tokenOut_,
            params.amountIn,
            finalAmountOut,
            context
        );
    }

    /* ───────────────────────────────────────────
       Single-pool supplicate (unchanged API)
       ─────────────────────────────────────────── */
    function supplicate(SupplicateParams calldata p)
        external
        override
        returns (uint256 amountOut)
    {
        require(access.isApprovedSupplicator(msg.sender), "not permitted");
        address payer = p.payer == address(0) ? msg.sender : p.payer;
        address to    = p.to    == address(0) ? msg.sender : p.to;

        address tokenIn  = p.assetToUsdc ? ILPPPool(p.pool).asset() : ILPPPool(p.pool).usdc();
        address tokenOut = p.assetToUsdc ? ILPPPool(p.pool).usdc()  : ILPPPool(p.pool).asset();

        _takeInputFeeAndDonate(p.pool, tokenIn, payer, p.amountIn);

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

    /* ───────────────────────────────────────────
       Single-pool with EIP-2612 (unchanged)
       ─────────────────────────────────────────── */
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
        PermitData calldata feePermit,
        PermitData calldata principalPermit
    ) external returns (uint256 amountOut) {
        require(access.isApprovedSupplicator(msg.sender), "not permitted");
        address payer = p.payer == address(0) ? msg.sender : p.payer;
        address to    = p.to    == address(0) ? msg.sender : p.to;

        address tokenIn  = p.assetToUsdc ? ILPPPool(p.pool).asset() : ILPPPool(p.pool).usdc();
        address tokenOut = p.assetToUsdc ? ILPPPool(p.pool).usdc()  : ILPPPool(p.pool).asset();

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

        _takeInputFeeAndDonate(p.pool, tokenIn, payer, p.amountIn);

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

    /* ───────────────────────────────────────────
       MCV: base path (now enforces aggregate minOut) (5)
       ─────────────────────────────────────────── */
    function mcvSupplication(MCVParams calldata params)
        external
        returns (uint256 finalAmountOut)
    {
        finalAmountOut = _mcvCore(
            params,
            /*usePermit2=*/false,
            Permit2Data({
                permit2: address(0),
                owner: address(0),
                amount: 0,
                nonce: 0,
                deadline: 0,
                signature: ""
            })
        );
    }

    /* ───────────────────────────────────────────
       MCV + EIP-2612 permits (unchanged behavior, checks aggregate minOut too)
       ─────────────────────────────────────────── */
    function mcvSupplication(
        MCVParams calldata params,
        PermitData calldata /*feePermit*/,
        PermitData[3] calldata /*hopPermits*/
    ) external returns (uint256 finalAmountOut) {
        // Keep existing path (caller already did EIP-2612 approvals).
        finalAmountOut = _mcvCore(
            params,
            /*usePermit2=*/false,
            Permit2Data({
                permit2: address(0),
                owner: address(0),
                amount: 0,
                nonce: 0,
                deadline: 0,
                signature: ""
            })
        );
    }

    /* ───────────────────────────────────────────
       (4) MCV + Permit2 single-signature path
       - Router becomes the payer (router-as-payer)
       - One signature authorizes router to pull fee+principal once, then
         router approves each pool to pull principal for that hop
       ─────────────────────────────────────────── */
    function mcvSupplication(
        MCVParams calldata params,
        Permit2Data calldata p2
    ) external returns (uint256 finalAmountOut) {
        // run core with Permit2 pull enabled
        finalAmountOut = _mcvCore(params, /*usePermit2=*/true, p2);
    }

    /* ───────────────────────────────────────────
       Internals
       ─────────────────────────────────────────── */
    function _mcvCore(
        MCVParams calldata params,
        bool usePermit2,
        Permit2Data memory p2   // <-- memory (fixes calldata literal conversion)
    ) internal returns (uint256 finalAmountOut) {
        require(params.amountIn > 0, "zero input");
        _consumeEventSlotOrRevert();

    (address[3] memory orbit, bool assetToUsdc, address tokenIn, ) =
        _resolveOrbitAndTokens(params.startPool, params.assetToUsdc);

        // Resolve payer / recipient from params (default to msg.sender if zero)
        address payer = params.payer == address(0) ? msg.sender : params.payer;
        address to    = params.to    == address(0) ? msg.sender : params.to;

        // If using Permit2, pre-pull fee+principal to router and set router as payer.
        if (usePermit2) {
            // compute total needed = 3*(amountIn + per-hop fee)
            uint256 feePerHop = (params.amountIn * MCV_FEE_BPS) / BPS_DENOMINATOR;
            uint256 totalNeeded = 3 * (params.amountIn + feePerHop);

            // safety: ensure fits uint160 for Permit2.transferFrom
            require(totalNeeded <= type(uint160).max, "Permit2 amount too large");

            // do Permit2.permit for router as spender
            IPermit2.PermitSingle memory ps = IPermit2.PermitSingle({
                permitted: IPermit2.TokenPermissions({ token: tokenIn, amount: p2.amount }),
                nonce: p2.nonce,
                deadline: p2.deadline,
                spender: address(this)
            });
            IPermit2(p2.permit2).permit(p2.owner, ps, p2.signature);

            // pull into router
            IPermit2(p2.permit2).transferFrom(p2.owner, address(this), uint160(totalNeeded), tokenIn);

            // switch payer to router (pools will pull principal from router; router approves per hop)
            payer = address(this);
        }

        // Execute 3 hops independently
        uint256 totalOut = 0;
        unchecked {
            for (uint256 i = 0; i < 3; i++) {
                totalOut += _executeIndependentHop(orbit[i], assetToUsdc, params.amountIn, payer, to, tokenIn);
            }
        }

        // (5) aggregate slippage guard
        if (params.minTotalAmountOut > 0 && totalOut < params.minTotalAmountOut) {
            revert Slippage(totalOut, params.minTotalAmountOut);
        }

        finalAmountOut = totalOut;

        // flip set if dual-orbit
        DualOrbit storage d2 = _dualOrbit[params.startPool];
        if (d2.initialized) {
            d2.useNegNext = !d2.useNegNext;
            emit OrbitFlipped(params.startPool, d2.useNegNext);
            emit DirectionFlipped(params.startPool, d2.useNegNext ? true : false);
        }
    }

    function _executeIndependentHop(
        address pool,
        bool assetToUsdc,
        uint256 amountIn,
        address payer,
        address to,
        address tokenIn /* resolved once */
    ) internal returns (uint256 grossOut) {
        require(pool != address(0), "zero pool");

        address tokenOut = assetToUsdc ? ILPPPool(pool).usdc() : ILPPPool(pool).asset();

        if (payer == address(this)) {
            // Router-as-payer path (Permit2): fees are paid from router balance,
            // pool pulls principal from router (so router must approve).
            _donateFromRouterBalance(pool, tokenIn, amountIn);
            IERC20(tokenIn).approve(pool, amountIn);
            grossOut = ILPPPool(pool).supplicate(address(this), address(this), assetToUsdc, amountIn, 0);
        } else {
            // Standard path: pull fees from payer, pool pulls principal from payer
            _takeInputFeeAndDonate(pool, tokenIn, payer, amountIn);
            grossOut = ILPPPool(pool).supplicate(payer, address(this), assetToUsdc, amountIn, 0);
        }

        IERC20(tokenOut).transfer(to, grossOut);
        emit HopExecuted(pool, assetToUsdc, tokenIn, tokenOut, amountIn, grossOut);
    }

    /// Pull fee on INPUT from `payer`, split to treasury + donate to pool input reserve.
    function _takeInputFeeAndDonate(
        address pool,
        address tokenIn,
        address payer,
        uint256 amountInBase
    ) internal {
        if (MCV_FEE_BPS == 0) return;

        uint256 totalFee   = (amountInBase * MCV_FEE_BPS) / BPS_DENOMINATOR;
        if (totalFee == 0) return;

        uint256 treasuryFt = (amountInBase * TREASURY_CUT_BPS) / BPS_DENOMINATOR;
        uint256 poolsFt    = totalFee - treasuryFt;

        IERC20(tokenIn).transferFrom(payer, address(this), totalFee);
        if (treasuryFt > 0) IERC20(tokenIn).transfer(treasury, treasuryFt);

        if (poolsFt > 0) {
            IERC20(tokenIn).transfer(pool, poolsFt);
            bool isUsdc = (tokenIn == ILPPPool(pool).usdc());
            ILPPPool(pool).donateToReserves(isUsdc, poolsFt);
        }

        emit FeeTaken(pool, tokenIn, amountInBase, totalFee, treasuryFt, poolsFt);
    }

    /// Same as above but pays from router balance (Permit2 path; router-as-payer).
    function _donateFromRouterBalance(
        address pool,
        address tokenIn,
        uint256 amountInBase
    ) internal {
        if (MCV_FEE_BPS == 0) return;

        uint256 totalFee   = (amountInBase * MCV_FEE_BPS) / BPS_DENOMINATOR;
        if (totalFee == 0) return;

        uint256 treasuryFt = (amountInBase * TREASURY_CUT_BPS) / BPS_DENOMINATOR;
        uint256 poolsFt    = totalFee - treasuryFt;

        if (treasuryFt > 0) IERC20(tokenIn).transfer(treasury, treasuryFt);
        if (poolsFt > 0) {
            IERC20(tokenIn).transfer(pool, poolsFt);
            bool isUsdc = (tokenIn == ILPPPool(pool).usdc());
            ILPPPool(pool).donateToReserves(isUsdc, poolsFt);
        }

        emit FeeTaken(pool, tokenIn, amountInBase, totalFee, treasuryFt, poolsFt);
    }

    /* ───────────────────────────────────────────
       Resolve helpers
       ─────────────────────────────────────────── */
    function _resolveOrbitAndTokens(address startPool, bool legacyAssetToUsdc)
        internal
        view
        returns (address[3] memory orbit, bool assetToUsdc, address tokenIn, address tokenOut)
    {
        // try dual-orbit
        DualOrbit memory d = _dualOrbit[startPool];
        if (d.initialized) {
            orbit = d.useNegNext ? d.neg : d.pos;
            assetToUsdc = d.useNegNext ? true : false;
        } else {
            OrbitConfig memory cfg = _orbitOf[startPool];
            if (!cfg.initialized) revert OrbitNotSet(startPool);
            orbit = cfg.pools;
            assetToUsdc = legacyAssetToUsdc;
        }

        address assetToken = ILPPPool(orbit[0]).asset();
        address usdcToken  = ILPPPool(orbit[0]).usdc();
        tokenIn  = assetToUsdc ? assetToken : usdcToken;
        tokenOut = assetToUsdc ? usdcToken  : assetToken;
    }

    /* ───────────────────────────────────────────
       Day/counter helpers
       ─────────────────────────────────────────── */
    function _today() private view returns (uint64) { return uint64(block.timestamp / 1 days); }

    function _rolledCounterView() private view returns (uint64 day, uint32 count) {
        uint64 t = _today();
        if (t == _eventsDay) return (_eventsDay, _eventsCount);
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
        unchecked { _eventsCount += 1; }
        emit DailyEventCounted(_eventsDay, _eventsCount);
    }
}