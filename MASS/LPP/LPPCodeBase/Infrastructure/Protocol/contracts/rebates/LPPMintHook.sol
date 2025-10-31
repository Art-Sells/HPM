// contracts/rebates/LPPMintHook.sol
// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;
pragma abicoder v2;

import "../interfaces/ILPPMintCallback.sol";
import "../interfaces/ILPPPool.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

interface ITokenDecimals { function decimals() external view returns (uint8); }

library Q96Math {
    uint256 internal constant Q192 = 2**192;
    function priceX192(uint160 sqrtPriceX96) internal pure returns (uint256) {
        return uint256(sqrtPriceX96) * uint256(sqrtPriceX96); // token1 per token0 in Q192
    }
}

/// Minimal manager surface that tests call through the Hook
interface ILPPPositionManager {
    /// Called by the hook after a successful mint to start a lock window
    function lockFromHook(uint32 secs) external;

    /// Test suite toggles this and expects longer locks downstream
    function setConservativeMode(bool enabled) external;
}

contract LPPMintHook is ILPPMintCallback {
    using SafeERC20 for IERC20;

    // --- Balanced-mint policy ---
    uint16 public balanceTolBps = 200;  // ±2% default tolerance
    bool   public requireBalanced = true;
    event BalancePolicyUpdated(uint16 tolBps, bool requireBalanced);

    // --- Config / ownership ---
    address public owner;
    address public vault;      // mutable so tests can set it post-deploy
    address public treasury;   // must be nonzero at deploy

    // Expose both names so tests can do hook.manager() or hook._manager()
    address public manager;
    address public _manager;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    // --- Canonical schedule tables ---
    // Contract tiers 0..3 correspond to human T1..T4 in tests
    uint16[4] public rebateBps;       // e.g. [100, 180, 250, 350]
    uint16[4] public retentionBps;    // e.g. [ 50,  90, 125, 175]

    // Breakpoints in bps: 10%, 20%, 35%, 50%
    uint16[4] public shareBreakBps;   // [1000, 2000, 3500, 5000]

    // Per-tier locks (seconds). Tests mutate via setLockSecs.
    uint32[4]  public lockSecs;       // default 0 (no lock)

    // --- Events ---
    event Qualified(address indexed pool, address indexed lp, uint256 shareBps, uint8 tier);
    event RebatePaid(address indexed to, address indexed pool, address indexed token, uint256 amount, uint8 tier);
    event Retained  (address indexed pool, address indexed token, uint256 amount, uint8 tier);
    event ManagerUpdated(address indexed newManager);
    event LockTableUpdated(uint32[4] secs);
    event TierTableUpdated(uint16[4] shareBreaks, uint16[4] rebates, uint16[4] retentions);

    // --- Ctor ---
    constructor(address _vault, address _treasury) {
        owner = msg.sender;
        vault = _vault; // may be zero at deploy; tests expect mint-time revert if zero
        require(_treasury != address(0), "treasury=0");
        treasury = _treasury;

        // Canonical defaults asserted in tests
        rebateBps     = [uint16(100), 180, 250, 350];
        retentionBps  = [uint16( 50),  90, 125, 175];
        shareBreakBps = [uint16(1000), 2000, 3500, 5000];
    }

    // --- Admin ---
    function setManager(address m) external onlyOwner {
        manager  = m;
        _manager = m;
        emit ManagerUpdated(m);
    }

    function setVault(address v) external onlyOwner {
        vault = v;
    }

    function setLockSecs(uint32[4] calldata secs) external onlyOwner {
        lockSecs = secs;
        emit LockTableUpdated(secs);
    }

    function setTiers(
        uint16[4] calldata _shareBreakBps,
        uint16[4] calldata _rebateBps,
        uint16[4] calldata _retentionBps
    ) external onlyOwner {
        shareBreakBps = _shareBreakBps;
        rebateBps     = _rebateBps;
        retentionBps  = _retentionBps;
        emit TierTableUpdated(_shareBreakBps, _rebateBps, _retentionBps);
    }

    function setBalancePolicy(uint16 tolBps, bool require_) external onlyOwner {
        require(tolBps <= 10_000, "tol>100%");
        balanceTolBps  = tolBps;
        requireBalanced = require_;
        emit BalancePolicyUpdated(tolBps, require_);
    }

    // --- Mint path ---
    struct MintParams {
        address pool;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        address recipient;
        address payer;
    }

    // keep callback context small to avoid stack pressure
    struct MintCtx {
        address payer;
        address lp;
        address pool;
        uint8 tier;
    }

    /// Mints liquidity into a pool and applies rebate/retention surcharge in the callback.
    /// Returns the owed leg amounts from the pool mint (named returns to save stack).
    function mintWithRebate(MintParams calldata p)
        external
        returns (uint256 amount0Owed, uint256 amount1Owed)
    {
        require(p.pool != address(0),      "pool=0");
        require(p.recipient != address(0), "recipient=0");
        require(p.payer != address(0),     "payer=0");
        require(p.liquidity > 0,           "liq=0");

        // Tests expect revert at call-site when vault is zero
        require(vault != address(0), "VAULT_ADDR_ZERO");

        uint8 tier_;
        bytes memory data;

        if (requireBalanced) {
            _precheckStraddle(p.pool, p.tickLower, p.tickUpper);
        }
        // Scope to limit stack usage before external call
        {
            uint128 Lbefore = ILPPPool(p.pool).liquidity();

            // share = L_mint / (L_before + L_mint)  (in bps)
            uint256 shareBps_ = (uint256(p.liquidity) * 10000)
                              / (uint256(Lbefore) + uint256(p.liquidity));

            tier_ = _tierFor(shareBps_);

            // If a tier is configured with 0 rebate, tests expect a revert
            require(rebateBps[tier_] != 0, "REBATE_BPS_ZERO");

            emit Qualified(p.pool, p.recipient, shareBps_, tier_);

            data = abi.encode(MintCtx({
                payer: p.payer,
                lp:    p.recipient,
                pool:  p.pool,
                tier:  tier_
            }));
        }

        // Pool will callback into lppMintCallback with owed amounts
        (amount0Owed, amount1Owed) = ILPPPool(p.pool).mint(
            p.recipient, p.tickLower, p.tickUpper, p.liquidity, data
        );

        // Optional locking: if a manager is wired and this tier has a lock, notify manager
        uint32 secs = lockSecs[tier_];
        address mgr = _manager;
        if (secs != 0 && mgr != address(0)) {
            ILPPPositionManager(mgr).lockFromHook(secs);
        }
    }

    // Tier mapping:
    //   <10%          -> tier 0
    //   10%–<20%      -> tier 1
    //   20%–<35%      -> tier 2
    //   >=50%         -> tier 3
    function _tierFor(uint256 shareBps_) internal view returns (uint8) {
        if (shareBps_ >= shareBreakBps[3]) return 3; // >= 50%
        if (shareBps_ >= shareBreakBps[1]) return 2; // >= 20%
        if (shareBps_ >= shareBreakBps[0]) return 1; // >= 10%
        return 0;                                    // < 10%
    }

    function _precheckStraddle(address pool, int24 lower, int24 upper) internal view {
        (, int24 tick,,,,,) = ILPPPool(pool).slot0();
        require(lower <= tick && tick <= upper, "RANGE_NOT_STRADDLE");
    }

    function _decimals(address token) internal view returns (uint8) {
        try ITokenDecimals(token).decimals() returns (uint8 d) { return d; }
        catch { return 18; }
    }

    function _enforceNear5050(
        address pool,
        uint256 amount0Owed,
        uint256 amount1Owed
    ) internal view {
        require(amount0Owed > 0 && amount1Owed > 0, "BOTH_TOKENS_REQUIRED");

        (uint160 sqrtPriceX96,, ,,,,) = ILPPPool(pool).slot0();
        address t0 = ILPPPool(pool).token0();
        address t1 = ILPPPool(pool).token1();

        uint8 d0 = _decimals(t0);
        uint8 d1 = _decimals(t1);

        // token1 per token0 in Q192, adjust for decimals
        uint256 px = Q96Math.priceX192(sqrtPriceX96);
        if (d1 >= d0) px = px * (10 ** (uint256(d1) - uint256(d0)));
        else          px = px / (10 ** (uint256(d0) - uint256(d1)));

        // value(token0) measured in token1 units (Q192 scaled)
        uint256 v0 = (amount0Owed * px) / Q96Math.Q192;
        uint256 v1 = amount1Owed;

        uint256 hi = v0 > v1 ? v0 : v1;
        uint256 lo = v0 > v1 ? v1 : v0;
        uint256 diffBps = (hi - lo) * 10_000 / hi;

        require(diffBps <= balanceTolBps, "IMBALANCED_MINT");
    }

    // --- Pool callback ---
    /// Pool calls back here with the owed leg(s). We:
    /// 1) pull owed amounts from payer -> pool
    /// 2) pull surcharge (rebate to vault, retention to treasury) from payer
    function lppMintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        MintCtx memory ctx = abi.decode(data, (MintCtx));
        require(msg.sender == ctx.pool, "bad caller");

        // Balanced-mint enforcement before any transfers
        if (requireBalanced) {
            _enforceNear5050(ctx.pool, amount0Owed, amount1Owed);
        }

        // Fetch tokens
        ILPPPool pool = ILPPPool(ctx.pool);
        address token0 = pool.token0();
        address token1 = pool.token1();
        IERC20 t0 = IERC20(token0);
        IERC20 t1 = IERC20(token1);

        // 1) settle owed legs to the pool
        if (amount0Owed > 0) t0.safeTransferFrom(ctx.payer, ctx.pool, amount0Owed);
        if (amount1Owed > 0) t1.safeTransferFrom(ctx.payer, ctx.pool, amount1Owed);

        // 2) compute & pull surcharge from payer
        uint256 rbps = rebateBps[ctx.tier];
        uint256 kbps = retentionBps[ctx.tier];

        if (amount0Owed > 0) {
            uint256 r0 = (amount0Owed * rbps) / 10000;
            uint256 k0 = (amount0Owed * kbps) / 10000;
            if (r0 > 0) {
                t0.safeTransferFrom(ctx.payer, vault, r0);
                emit RebatePaid(ctx.payer, ctx.pool, token0, r0, ctx.tier);
            }
            if (k0 > 0) {
                t0.safeTransferFrom(ctx.payer, treasury, k0);
                emit Retained(ctx.pool, token0, k0, ctx.tier);
            }
        }

        if (amount1Owed > 0) {
            uint256 r1 = (amount1Owed * rbps) / 10000;
            uint256 k1 = (amount1Owed * kbps) / 10000;
            if (r1 > 0) {
                t1.safeTransferFrom(ctx.payer, vault, r1);
                emit RebatePaid(ctx.payer, ctx.pool, token1, r1, ctx.tier);
            }
            if (k1 > 0) {
                t1.safeTransferFrom(ctx.payer, treasury, k1);
                emit Retained(ctx.pool, token1, k1, ctx.tier);
            }
        }
    }
}