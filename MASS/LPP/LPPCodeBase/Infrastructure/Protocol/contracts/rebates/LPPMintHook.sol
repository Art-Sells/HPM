// contracts/rebates/LPPMintHook.sol
// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;
pragma abicoder v2;

import "../interfaces/ILPPMintCallback.sol";
import "../interfaces/ILPPPool.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

/// Minimal manager surface that tests call through the Hook
interface ILPPPositionManager {
    /// Called by the hook after a successful mint to start a lock window
    function lockFromHook(uint32 secs) external;

    /// Test suite toggles this and expects longer locks downstream
    function setConservativeMode(bool enabled) external;
}

contract LPPMintHook is ILPPMintCallback {
    using SafeERC20 for IERC20;

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

        // Only the specific pool this mint targeted can callback
        require(msg.sender == ctx.pool, "bad caller");

        // Fetch tokens on-demand to keep ctx small on the mint side
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