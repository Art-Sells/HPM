// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPRouter }          from "./interfaces/ILPPRouter.sol";
import { ILPPAccessManager }   from "./interfaces/ILPPAccessManager.sol";
import { ILPPPool }            from "./interfaces/ILPPPool.sol";
import { IERC20 }              from "./external/IERC20.sol";

contract LPPRouter is ILPPRouter {
    ILPPAccessManager public immutable access;
    address public immutable treasury;

    /* -------- Fees (public constants = auto getters) -------- */
    uint16 public constant override BPS_DENOMINATOR = 10_000;
    uint16 public constant override MCV_FEE_BPS      = 120; // 1.2% per hop
    uint16 public constant override TREASURY_CUT_BPS = 20;  // .2% of hop input
    uint16 public constant POOLS_CUT_BPS             = 100; // 1% of hop input

    /* -------- Daily cap tracking -------- */
    uint16 public override dailyEventCap = 500;
    uint16 public override dailyEventCount;
    uint32 private _dailyEventDay;

    /* -------- Pause state -------- */
    bool public paused;

    /* -------- Orbit storage -------- */
    struct OrbitConfig { address[3] pools; bool initialized; }
    mapping(address => OrbitConfig) private _orbitOf;

    struct DualOrbit {
        address[3] neg;     // NEG set  => ASSET-in  (asset->usdc)
        address[3] pos;     // POS set  => USDC-in   (usdc->asset)
        bool useNegNext;    // flips on each swap() call
        bool initialized;
    }
    mapping(address => DualOrbit) private _dualOrbit;

    /* -------- Errors -------- */
    error OrbitNotSet(address startPool);
    error DailyEventCapReached(uint16 cap);
    error RouterPaused();

    /* -------- Events (MEV traces, admin) -------- */
    event OrbitUpdated(address indexed startPool, address[3] pools);
    event DualOrbitUpdated(address indexed startPool, address[3] neg, address[3] pos, bool startWithNeg);
    event OrbitFlipped(address indexed startPool, bool nowUsingNeg);
    event DailyEventCapUpdated(uint16 newCap);
    event DailyEventWindowRolled(uint32 indexed dayIndex);
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

    /* -------- Auth -------- */
    modifier onlyTreasury() { require(msg.sender == treasury, "not treasury"); _; }
    modifier whenNotPaused() { if (paused) revert RouterPaused(); _; }

    constructor(address accessManager, address treasury_) {
        require(accessManager != address(0), "zero access");
        require(treasury_ != address(0), "zero treasury");
        access = ILPPAccessManager(accessManager);
        treasury = treasury_;
        _dailyEventDay = _currentDay();
    }

    /* ───────────────────────────────────────────
       Orbit config (legacy single + dual)
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

    /* ───────────────────────────────────────────
       Daily event guard administration & view
       ─────────────────────────────────────────── */

    function setDailyEventCap(uint16 newCap) external override onlyTreasury {
        require(newCap > 0, "cap zero");
        dailyEventCap = newCap;
        if (dailyEventCount > newCap) {
            dailyEventCount = newCap;
        }
        emit DailyEventCapUpdated(newCap);
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

    function getDailyEventWindow()
        external
        view
        override
        returns (uint32 dayIndex, uint16 count, uint16 cap)
    {
        return (_dailyEventDay, dailyEventCount, dailyEventCap);
    }

    /* ───────────────────────────────────────────
       Single-pool (permissioned) — NO orbit flip
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

        address tokenIn  = p.assetToUsdc ? ILPPPool(p.pool).asset() : ILPPPool(p.pool).usdc();
        address tokenOut = p.assetToUsdc ? ILPPPool(p.pool).usdc()  : ILPPPool(p.pool).asset();

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
       3-hop MCV / MEV — DOES orbit flip
       ─────────────────────────────────────────── */

    function swap(SwapParams calldata p)
        external
        override
        whenNotPaused
        returns (uint256 totalOut)
    {
        require(p.amountIn > 0, "zero input");
        _preCheckDailyCap();

        (address[3] memory orbit, bool assetToUsdc, address tokenIn, address tokenOut) =
            _resolveOrbitAndTokens(p.startPool, p.assetToUsdc);

        address payer = p.payer == address(0) ? msg.sender : p.payer;
        address to    = p.to    == address(0) ? msg.sender : p.to;

        unchecked {
            for (uint256 i = 0; i < 3; i++) {
                address pool = orbit[i];

                _takeInputFeeAndDonate(pool, tokenIn, payer, p.amountIn);

                uint256 out = ILPPPool(pool).supplicate(
                    payer,
                    address(this),
                    assetToUsdc,
                    p.amountIn,
                    0 // per-hop minOut ignored; aggregate guard below
                );

                totalOut += out;
                emit HopExecuted(pool, assetToUsdc, tokenIn, tokenOut, p.amountIn, out);
            }
        }

        if (p.minTotalAmountOut > 0) {
            require(totalOut >= p.minTotalAmountOut, "slippage");
        }

        IERC20(tokenOut).transfer(to, totalOut);

        DualOrbit storage d = _dualOrbit[p.startPool];
        if (d.initialized) {
            d.useNegNext = !d.useNegNext;
            emit OrbitFlipped(p.startPool, d.useNegNext);
        }

        _incrementDailyCount();
    }

    /* ───────────────────────────────────────────
       Quoting
       ─────────────────────────────────────────── */

    function getAmountsOut(
        uint256 amountIn,
        address[3] calldata orbit,
        bool assetToUsdc
    ) external view override returns (uint256[3] memory perHop, uint256 total) {
        require(amountIn > 0, "amountIn=0");
        uint256 x = amountIn;

        unchecked {
            for (uint256 i = 0; i < 3; i++) {
                address pool = orbit[i];
                require(pool != address(0), "zero pool");

                uint256 rA = ILPPPool(pool).reserveAsset();
                uint256 rU = ILPPPool(pool).reserveUsdc();
                require(rA > 0 && rU > 0, "empty reserves");

                uint256 out = assetToUsdc
                    ? (x * rU) / (rA + x)  // ASSET-in  ⇒ USDC-out
                    : (x * rA) / (rU + x); // USDC-in   ⇒ ASSET-out

                perHop[i] = out;
                total += out;
            }
        }
    }

    function getAmountsOutFromStart(
        address startPool,
        uint256 amountIn
    )
        external
        view
        override
        returns (
            bool assetToUsdc,
            address[3] memory orbit,
            uint256[3] memory perHop,
            uint256 total
        )
    {
        (orbit, assetToUsdc, , ) = _resolveOrbitAndTokens(startPool, /*legacy*/ false);
        (perHop, total) = this.getAmountsOut(amountIn, orbit, assetToUsdc);
    }

    /* ───────────────────────────────────────────
       Internals
       ─────────────────────────────────────────── */

    function _resolveOrbitAndTokens(address startPool, bool legacyAssetToUsdc)
        internal
        view
        returns (address[3] memory orbit, bool assetToUsdc, address tokenIn, address tokenOut)
    {
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

        address a = ILPPPool(orbit[0]).asset();
        address u = ILPPPool(orbit[0]).usdc();
        tokenIn  = assetToUsdc ? a : u;
        tokenOut = assetToUsdc ? u : a;
    }

    function _preCheckDailyCap() internal {
        _syncDailyWindow();
        if (dailyEventCount >= dailyEventCap) revert DailyEventCapReached(dailyEventCap);
    }

    function _incrementDailyCount() internal {
        unchecked {
            dailyEventCount += 1;
        }
    }

    function _syncDailyWindow() internal {
        uint32 today = _currentDay();
        if (today != _dailyEventDay) {
            _dailyEventDay = today;
            dailyEventCount = 0;
            emit DailyEventWindowRolled(today);
        }
    }

    function _currentDay() internal view returns (uint32) {
        return uint32(block.timestamp / 1 days);
    }

    /// Pull fee on INPUT from `payer`, split to treasury + donate to pool input reserve.
    function _takeInputFeeAndDonate(
        address pool,
        address tokenIn,
        address payer,
        uint256 amountInBase
    ) internal {
        if (MCV_FEE_BPS == 0) return;

        uint256 totalFee = (amountInBase * MCV_FEE_BPS) / BPS_DENOMINATOR;
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
}