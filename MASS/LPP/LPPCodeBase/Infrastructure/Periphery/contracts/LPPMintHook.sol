// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.7.6;
pragma abicoder v2;

/*
  Hook that:
  - Calls the *rebate* entrypoint on the pool (ILPPPoolRebate.mintWithRebate).
  - Pays owed amounts in lppMintCallback by pulling from `payer` (who approved this hook).
  - Classifies tier from share (minted liquidity / tvlAfter), applies rebate/retention,
    and hands control back to the manager via finalize*FromHook.
*/

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

interface ILPPPoolMinimal {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function liquidity() external view returns (uint128);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

// Rebate entrypoint (pool)
import "./interfaces/ILPPPoolRebate.sol";
// Price/tick + liquidity math
import "@lpp/lpp-protocol/contracts/libraries/TickMath.sol";
import "./libraries/LiquidityAmounts.sol";

// Manager entrypoints (periphery)
import "./interfaces/IHookEntrypoints.sol";
import "./interfaces/IHookMint.sol";

contract LPPMintHook is IHookMint {
    // ------------------------------------------------------------------------
    // Storage / config
    // ------------------------------------------------------------------------
    address public owner;
    address public manager;   // NonfungiblePositionManager
    address public vault;     // rebate sink
    address public treasury;  // retention sink

    // Tier tables (indices 0..3). Breaks are share (bps) of tvlAfter.
    uint16[4] private _shareBreaksBps;
    uint16[4] private _rebateBps;
    uint16[4] private _retentionBps;
    uint32[4]  private _lockSecs;

    // Value-imbalance tolerance (bps) between amount0 vs amount1 (default 200 = 2%)
    uint16 public balanceTolBps = 200;

    // ------------------------------------------------------------------------
    // Events (expected by your tests)
    // ------------------------------------------------------------------------
    event Qualified(address indexed pool, address indexed lp, uint8 tier, uint16 shareBps);
    event RebatePaid(address indexed to, address indexed pool, address indexed token, uint256 amount, uint8 tier);
    event Retained(address indexed pool, address indexed token, uint256 amount, uint8 tier);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _vault, address _treasury) {
        require(_vault != address(0), "VAULT_ADDR_ZERO");
        require(_treasury != address(0), "TREAS_ADDR_ZERO");
        owner = msg.sender;
        vault = _vault;
        treasury = _treasury;

        // 10%, 20%, 35%, 50% (cap)
        _shareBreaksBps = [uint16(1000), uint16(2000), uint16(3500), uint16(5000)];
        // Canonical BPS from your tests
        _rebateBps      = [uint16(100),  uint16(180),  uint16(250),  uint16(350) ];
        _retentionBps   = [uint16(50),   uint16(90),   uint16(125),  uint16(175) ];
        _lockSecs       = [uint32(6 hours), uint32(1 days), uint32(3 days), uint32(7 days)];
    }

    // ---------------- admin ----------------
    function setManager(address _manager) external onlyOwner {
        require(_manager != address(0), "manager=0");
        manager = _manager;
    }
    function setTiers(uint16[4] calldata breaksBps, uint16[4] calldata rebateBps_, uint16[4] calldata retentionBps_) external onlyOwner {
        _shareBreaksBps = breaksBps; _rebateBps = rebateBps_; _retentionBps = retentionBps_;
    }
    function setLockSecs(uint32[4] calldata lockSecs_) external onlyOwner { _lockSecs = lockSecs_; }
    function setBalanceTolBps(uint16 tolBps) external onlyOwner { require(tolBps <= 10_000, "bad tol"); balanceTolBps = tolBps; }

    // getters your tests call
    function rebateBps(uint256 i) external view returns (uint16) { return _rebateBps[i]; }
    function retentionBps(uint256 i) external view returns (uint16) { return _retentionBps[i]; }
    function lockSecs(uint256 i) external view returns (uint32) { return _lockSecs[i]; }

    // ------------------------------------------------------------------------
    // Pool callback: pay owed from `payer`
    // ------------------------------------------------------------------------
    function lppMintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external {
        (address _manager, address payer) = abi.decode(data, (address, address));
        address pool = msg.sender;

        address t0 = ILPPPoolMinimal(pool).token0();
        address t1 = ILPPPoolMinimal(pool).token1();

        if (amount0Owed > 0) _safeTransferFrom(t0, payer, pool, amount0Owed);
        if (amount1Owed > 0) _safeTransferFrom(t1, payer, pool, amount1Owed);
    }

    // ------------------------------------------------------------------------
    // IHookMint: manager -> hook (fresh mint)
    // ------------------------------------------------------------------------
    function mintViaHook(MintViaHookParams calldata p) external override {
        require(manager != address(0), "manager unset");
        require(p.pool != address(0), "pool=0");
        require(p.recipient != address(0), "recipient=0");
        require(p.payer != address(0), "payer=0");

        ILPPPoolMinimal pool = ILPPPoolMinimal(p.pool);

        // Compute liquidity from desired amounts and current price
        uint128 mintedLiq = _liquidityFromDesired(pool, p.tickLower, p.tickUpper, p.amount0Desired, p.amount1Desired);
        require(mintedLiq > 0, "liq=0");

        // Route to rebate entrypoint (callback pulls from payer)
        (uint256 amount0, uint256 amount1) = ILPPPoolRebate(address(pool)).mintWithRebate(
            manager,
            p.tickLower,
            p.tickUpper,
            mintedLiq,
            p.payer,
            abi.encode(manager, p.payer)
        );

        // Range must straddle current tick → both legs > 0
        require(amount0 > 0 && amount1 > 0, "RANGE_NOT_STRADDLE");
        _checkBalancedValue(pool, amount0, amount1);

        // Share = minted / tvlAfter
        uint128 tvlAfter = pool.liquidity();
        require(tvlAfter > 0, "tvlAfter=0");
        uint16 shareBps = _shareBpsFromMinted(mintedLiq, tvlAfter);
        uint8 tier = _tierForShare(shareBps);

        // Apply rebates/retention (pulls surcharge from payer)
        _applyRebatesAndRetention(pool, p.payer, amount0, amount1, tier);

        emit Qualified(p.pool, p.recipient, tier, shareBps);

        // hand back to manager (manager snapshots fee growth, mints NFT, locks, etc.)
        IHookEntrypoints(manager).finalizeMintFromHook(
            p.pool,
            p.recipient,
            p.tickLower,
            p.tickUpper,
            mintedLiq,
            amount0,
            amount1
        );
    }

    // ------------------------------------------------------------------------
    // IHookMint: manager -> hook (increase)
    // ------------------------------------------------------------------------
    function increaseViaHook(IncreaseViaHookParams calldata p) external override {
        require(manager != address(0), "manager unset");
        require(p.pool != address(0), "pool=0");
        require(p.payer != address(0), "payer=0");

        ILPPPoolMinimal pool = ILPPPoolMinimal(p.pool);

        uint128 addedLiq = _liquidityFromDesired(pool, p.tickLower, p.tickUpper, p.amount0Desired, p.amount1Desired);
        require(addedLiq > 0, "liq=0");

        (uint256 amount0, uint256 amount1) = ILPPPoolRebate(address(pool)).mintWithRebate(
            manager,
            p.tickLower,
            p.tickUpper,
            addedLiq,
            p.payer,
            abi.encode(manager, p.payer)
        );

        require(amount0 > 0 && amount1 > 0, "RANGE_NOT_STRADDLE");
        _checkBalancedValue(pool, amount0, amount1);

        uint128 tvlAfter = pool.liquidity();
        require(tvlAfter > 0, "tvlAfter=0");
        uint16 shareBps = _shareBpsFromMinted(addedLiq, tvlAfter);
        uint8 tier = _tierForShare(shareBps);

        _applyRebatesAndRetention(pool, p.payer, amount0, amount1, tier);

        emit Qualified(p.pool, address(0), tier, shareBps);

        IHookEntrypoints(manager).finalizeIncreaseFromHook(
            p.pool,
            p.tokenId,
            p.tickLower,
            p.tickUpper,
            addedLiq,
            amount0,
            amount1
        );
    }

    // ------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------
    function _tierForShare(uint16 shareBps) internal view returns (uint8) {
        if (shareBps < _shareBreaksBps[0]) return 0;
        if (shareBps < _shareBreaksBps[1]) return 1;
        if (shareBps < _shareBreaksBps[2]) return 2;
        return 3;
    }

    function _checkBalancedValue(ILPPPoolMinimal pool, uint256 amount0, uint256 amount1) internal view {
        if (balanceTolBps == 0) return;
        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();
        // value(token0) in token1 units @ current price: (amount0 * P) with P = (sqrtP^2)/2^192
        uint256 pxQ192 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        uint256 v0 = (amount0 * pxQ192) >> 192;
        uint256 v1 = amount1;
        uint256 hi = v0 > v1 ? v0 : v1;
        uint256 lo = v0 > v1 ? v1 : v0;
        if (hi == 0) return;
        uint256 diffBps = (hi - lo) * 10_000 / hi;
        require(diffBps <= balanceTolBps, "IMBALANCED_MINT");
    }

    function _applyRebatesAndRetention(
        ILPPPoolMinimal pool,
        address payer,
        uint256 amount0,
        uint256 amount1,
        uint8 tier
    ) internal {
        require(_rebateBps[tier] > 0, "REBATE_BPS_ZERO");

        address t0 = pool.token0();
        address t1 = pool.token1();

        uint256 rb0 = amount0 * _rebateBps[tier]    / 10_000;
        uint256 rb1 = amount1 * _rebateBps[tier]    / 10_000;
        uint256 kt0 = amount0 * _retentionBps[tier] / 10_000;
        uint256 kt1 = amount1 * _retentionBps[tier] / 10_000;

        if (rb0 > 0) { _safeTransferFrom(t0, payer, vault,    rb0); emit RebatePaid(vault,    address(pool), t0, rb0, tier); }
        if (rb1 > 0) { _safeTransferFrom(t1, payer, vault,    rb1); emit RebatePaid(vault,    address(pool), t1, rb1, tier); }
        if (kt0 > 0) { _safeTransferFrom(t0, payer, treasury, kt0); emit Retained(             address(pool), t0, kt0, tier); }
        if (kt1 > 0) { _safeTransferFrom(t1, payer, treasury, kt1); emit Retained(             address(pool), t1, kt1, tier); }
    }

    // --- Liquidity math (real, not stub) -----------------------------------
    function _liquidityFromDesired(
        ILPPPoolMinimal pool,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0Desired,
        uint256 amount1Desired
    ) internal view returns (uint128) {
        require(tickLower < tickUpper, "ticks");
        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();

        uint160 sqrtA = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtRatioAtTick(tickUpper);
        if (sqrtA > sqrtB) { (sqrtA, sqrtB) = (sqrtB, sqrtA); } // defensive

        return LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            sqrtA,
            sqrtB,
            amount0Desired,
            amount1Desired
        );
    }

    // share(bps) = minted / tvlAfter * 10_000  (capped at 10_000)
    function _shareBpsFromMinted(uint128 mintedLiq, uint128 tvlAfter) internal pure returns (uint16) {
        if (tvlAfter == 0 || mintedLiq == 0) return 0;
        uint256 bps = (uint256(mintedLiq) * 10_000) / uint256(tvlAfter);
        if (bps > 10_000) bps = 10_000;
        return uint16(bps);
    }

    function _safeTransferFrom(address token, address from, address to, uint256 value) internal {
        if (value == 0) return;
        bool ok = IERC20Minimal(token).transferFrom(from, to, value);
        require(ok, "TF_FAILED");
    }
}