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
    struct OrbitConfig { address[] pools; bool initialized; }
    mapping(address => OrbitConfig) private _orbitOf;

    struct DualOrbit {
        address[] neg;     // NEG set  => ASSET-in  (asset->usdc)
        address[] pos;     // POS set  => USDC-in   (usdc->asset)
        bool useNegNext;    // deprecated - kept for backwards compatibility, not used
        bool initialized;
    }
    mapping(address => DualOrbit) private _dualOrbit;

    /* -------- Errors -------- */
    error OrbitNotSet(address startPool);
    error DailyEventCapReached(uint16 cap);
    error RouterPaused();

    /* -------- Events (MEV traces, admin) -------- */
    event OrbitUpdated(address indexed startPool, address[] pools);
    event DualOrbitUpdated(address indexed startPool, address[] neg, address[] pos, bool startWithNeg);
    event OrbitFlipped(address indexed startPool, bool usedNegOrbit);
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

    function setOrbit(address startPool, address[] calldata pools_) external onlyTreasury {
        require(startPool != address(0), "orbit: zero start");
        require(pools_.length > 0, "orbit: empty");
        for (uint256 i = 0; i < pools_.length; i++) {
            require(pools_[i] != address(0), "orbit: zero pool");
        }

        address a0 = ILPPPool(pools_[0]).asset();
        address u0 = ILPPPool(pools_[0]).usdc();
        for (uint256 i = 1; i < pools_.length; i++) {
            require(ILPPPool(pools_[i]).asset() == a0 && ILPPPool(pools_[i]).usdc() == u0, "orbit: mismatched pair");
        }

        _orbitOf[startPool] = OrbitConfig({ pools: pools_, initialized: true });
        emit OrbitUpdated(startPool, pools_);
    }

    function getOrbit(address startPool) external view returns (address[] memory pools) {
        OrbitConfig memory cfg = _orbitOf[startPool];
        require(cfg.initialized, "orbit: not set");
        return cfg.pools;
    }

    function setDualOrbit(
        address startPool,
        address[] calldata neg,
        address[] calldata pos,
        bool startWithNeg
    ) external onlyTreasury {
        require(startPool != address(0), "dual: zero start");
        require(neg.length > 0 && pos.length > 0, "dual: empty orbit");
        require(neg.length == pos.length, "dual: length mismatch");
        
        for (uint256 i = 0; i < neg.length; i++) {
            require(neg[i] != address(0) && pos[i] != address(0), "dual: zero pool");
        }
        
        address a0 = ILPPPool(neg[0]).asset();
        address u0 = ILPPPool(neg[0]).usdc();
        for (uint256 i = 1; i < neg.length; i++) {
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
        returns (address[] memory orbit, bool usingNeg)
    {
        DualOrbit memory d = _dualOrbit[startPool];
        require(d.initialized, "dual: not set");
        // No longer tracks active orbit - searchers choose. Return NEG as default.
        return (d.neg, true);
    }

    function getDualOrbit(address startPool)
        external
        view
        returns (address[] memory neg, address[] memory pos, bool usingNeg)
    {
        DualOrbit memory d = _dualOrbit[startPool];
        require(d.initialized, "dual: not set");
        // usingNeg is no longer meaningful since searchers choose. Return false as placeholder.
        return (d.neg, d.pos, false);
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

        (address[] memory orbit, bool assetToUsdc, address tokenIn, address tokenOut) =
            _resolveOrbitAndTokens(p.startPool, p.assetToUsdc);

        address payer = p.payer == address(0) ? msg.sender : p.payer;
        address to    = p.to    == address(0) ? msg.sender : p.to;

        unchecked {
            for (uint256 i = 0; i < orbit.length; i++) {
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

        // After swap completes, flip the offset of each pool in the orbit
        DualOrbit storage d = _dualOrbit[p.startPool];
        if (d.initialized) {
            unchecked {
                for (uint256 i = 0; i < orbit.length; i++) {
                    ILPPPool(orbit[i]).flipOffset();
                }
            }
            emit OrbitFlipped(p.startPool, assetToUsdc); // emit which orbit was used
        }

        _incrementDailyCount();
    }

    /* ───────────────────────────────────────────
       Quoting
       ─────────────────────────────────────────── */

    function getAmountsOut(
        uint256 amountIn,
        address[] calldata orbit,
        bool assetToUsdc
    ) external view override returns (uint256[] memory perHop, uint256 total) {
        require(amountIn > 0, "amountIn=0");
        require(orbit.length > 0, "empty orbit");
        uint256 x = amountIn;
        perHop = new uint256[](orbit.length);

        unchecked {
            for (uint256 i = 0; i < orbit.length; i++) {
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

    /// @notice Get quote with total cost (amount extracted from wallet)
    /// @dev Returns both output amounts AND total input cost (amountIn * numHops + fees)
    function getAmountsOutWithCost(
        uint256 amountIn,
        address[] calldata orbit,
        bool assetToUsdc
    ) external view returns (
        uint256[] memory perHop,
        uint256 totalOut,
        uint256 totalInputCost,
        uint256 totalFees
    ) {
        require(amountIn > 0, "amountIn=0");
        require(orbit.length > 0, "empty orbit");
        
        (perHop, totalOut) = this.getAmountsOut(amountIn, orbit, assetToUsdc);
        
        // Calculate total cost: amountIn per hop + fees per hop
        // swap() takes p.amountIn from payer for EACH hop, plus fees on each hop
        uint256 numHops = uint256(orbit.length);
        uint256 feePerHop = (amountIn * MCV_FEE_BPS) / BPS_DENOMINATOR;
        
        totalFees = feePerHop * numHops;
        totalInputCost = (amountIn * numHops) + totalFees;
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
            address[] memory orbit,
            uint256[] memory perHop,
            uint256 total
        )
    {
        // Default to NEG orbit (ASSET→USDC) for backwards compatibility
        // Searchers should use getAmountsOutFromStartWithDirection to specify
        return this.getAmountsOutFromStartWithDirection(startPool, amountIn, true);
    }
    
    /// @notice Get amounts out for a specific orbit direction (searcher's choice)
    function getAmountsOutFromStartWithDirection(
        address startPool,
        uint256 amountIn,
        bool useNegOrbit
    )
        external
        view
        returns (
            bool assetToUsdc,
            address[] memory orbit,
            uint256[] memory perHop,
            uint256 total
        )
    {
        (orbit, assetToUsdc, , ) = _resolveOrbitAndTokens(startPool, useNegOrbit);
        (perHop, total) = this.getAmountsOut(amountIn, orbit, assetToUsdc);
    }

    /// @notice Get quote with total cost (amount extracted from wallet)
    /// @dev Returns output amounts AND total input cost (amountIn * numHops + fees per hop)
    /// This is what MEV bots need to calculate profitability
    function getAmountsOutFromStartWithCost(
        address startPool,
        uint256 amountIn,
        bool useNegOrbit
    )
        external
        view
        returns (
            bool assetToUsdc,
            address[] memory orbit,
            uint256[] memory perHop,
            uint256 totalOut,
            uint256 totalInputCost,
            uint256 totalFees
        )
    {
        (orbit, assetToUsdc, , ) = _resolveOrbitAndTokens(startPool, useNegOrbit);
        (perHop, totalOut) = this.getAmountsOut(amountIn, orbit, assetToUsdc);
        
        // Calculate total cost: amountIn per hop + fees per hop
        // swap() takes p.amountIn from payer for EACH hop, plus fees
        uint256 numHops = uint256(orbit.length);
        uint256 feePerHop = (amountIn * MCV_FEE_BPS) / BPS_DENOMINATOR;
        uint256 principalPerHop = amountIn;
        
        totalFees = feePerHop * numHops;
        totalInputCost = (principalPerHop * numHops) + totalFees;
    }

    /* ───────────────────────────────────────────
       Internals
       ─────────────────────────────────────────── */

    function _resolveOrbitAndTokens(address startPool, bool searcherAssetToUsdc)
        internal
        view
        returns (address[] memory orbit, bool assetToUsdc, address tokenIn, address tokenOut)
    {
        DualOrbit memory d = _dualOrbit[startPool];
        if (d.initialized) {
            // Use searcher's choice: assetToUsdc=true means NEG orbit (ASSET→USDC)
            // assetToUsdc=false means POS orbit (USDC→ASSET)
            orbit = searcherAssetToUsdc ? d.neg : d.pos;
            assetToUsdc = searcherAssetToUsdc;
        } else {
            OrbitConfig memory cfg = _orbitOf[startPool];
            if (!cfg.initialized) revert OrbitNotSet(startPool);
            orbit = cfg.pools;
            assetToUsdc = searcherAssetToUsdc;
        }

        require(orbit.length > 0, "empty orbit");
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