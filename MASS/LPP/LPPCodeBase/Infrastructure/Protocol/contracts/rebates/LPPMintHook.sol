// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.20;

import "../interfaces/IERC20Minimal.sol";
import "../interfaces/ILPPPool.sol";
import "../interfaces/ILPPPositionManager.sol";
import "../utils/Ownable.sol";

contract LPPMintHook is Ownable {
    error REBATE_BPS_ZERO();
    error VAULT_ADDR_ZERO();
    error TREASURY_ADDR_ZERO();

    event Qualified(address indexed lp, address indexed pool, uint8 tier, uint16 shareBps);
    event RebatePaid(address indexed lp, address indexed pool, address token, uint256 amount, uint8 tier);
    event Retained(address indexed pool, address token, uint256 amount, uint8 tier);
    event VaultUpdated(address indexed oldVault, address indexed newVault);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event LockTableUpdated(uint32[4] lockSecs);
    event ManagerUpdated(address indexed oldManager, address indexed newManager);

    address public vault;      // rebate destination
    address public treasury;   // retention destination
    address public manager;    // optional position manager (can be zero until wired)

    // tier tables (indices 0..3 correspond to T1..T4)
    uint16[4] public rebateBps;
    uint16[4] public retentionBps;
    uint32[4] public lockSecs; // base lock duration per tier (seconds)
    uint16[4] public shareBreaksBps; // e.g., [1000, 2000, 3500, 5000]

    constructor(address _vault, address _treasury) {
        if (_vault == address(0)) revert VAULT_ADDR_ZERO();
        if (_treasury == address(0)) revert TREASURY_ADDR_ZERO();
        vault = _vault;
        treasury = _treasury;

        // sensible defaults (can be updated by owner)
        rebateBps      = [uint16(100), 180, 250, 350];
        retentionBps   = [uint16( 50),  90, 125, 175];
        lockSecs       = [uint32(6 hours), 1 days, 3 days, 7 days];
        shareBreaksBps = [1000, 2000, 3500, 5000];
    }

    // ----- admin -----
    function setLockSecs(uint32[4] calldata secs) external onlyOwner {
        lockSecs = secs;
        emit LockTableUpdated(secs);
    }

    function setTiers(
        uint16[4] calldata _shareBreaksBps,
        uint16[4] calldata _rebateBps,
        uint16[4] calldata _retentionBps
    ) external onlyOwner {
        shareBreaksBps = _shareBreaksBps;
        rebateBps      = _rebateBps;
        retentionBps   = _retentionBps;
    }

    function setVault(address v) external onlyOwner {
        if (v == address(0)) revert VAULT_ADDR_ZERO();
        emit VaultUpdated(vault, v);
        vault = v;
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert TREASURY_ADDR_ZERO();
        emit TreasuryUpdated(treasury, t);
        treasury = t;
    }

    function setManager(address m) external onlyOwner {
        emit ManagerUpdated(manager, m);
        manager = m;
    }

    // ----- core -----
    struct MintParams {
        address pool;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        address recipient;
        address payer;
    }

    function mintWithRebate(MintParams calldata p) external returns (uint256 tokenId) {
        // 1) qualify tier by share (% of TVL you’re adding)
        uint16 shareBps = _computeShareBps(p.pool, p.liquidity);
        uint8 tier = _tierForShareBps(shareBps);

        // **enforce**: must have a non-zero rebate bps and a live vault
        if (rebateBps[tier] == 0) revert REBATE_BPS_ZERO();
        if (vault == address(0)) revert VAULT_ADDR_ZERO();

        emit Qualified(p.recipient, p.pool, tier, shareBps);

        // 2) pool.mint (hook is msg.sender)
        (uint256 amt0, uint256 amt1) = _doPoolMint(p);

        // 3) pull surcharge from payer -> vault (rebate) & treasury (retention)
        _settleSurcharge(p.payer, p.pool, amt0, amt1, tier, p.recipient);

        // 4) optional: impose lock via manager if configured
        if (manager != address(0)) {
            tokenId = ILPPPositionManager(manager).finalizeMintFromHook(
                p.pool, p.recipient, p.tickLower, p.tickUpper, p.liquidity, tier, lockSecs[tier]
            );
        } else {
            tokenId = 0;
        }
    }

    // ----- helpers -----
    function _tierForShareBps(uint16 sBps) internal view returns (uint8) {
        if (sBps < shareBreaksBps[0]) return 0;
        if (sBps < shareBreaksBps[1]) return 1;
        if (sBps < shareBreaksBps[2]) return 2;
        return 3; // >= 3rd break → T4
    }

    /** Share in bps = liq / (liq + tvl) * 10_000, using pool.liquidity() like Uniswap V3 */
    function _computeShareBps(address pool, uint128 liq) internal view returns (uint16) {
        uint128 tvl = ILPPPool(pool).liquidity(); // assumes ILPPPool exposes liquidity()
        uint256 denom = uint256(tvl) + uint256(liq);
        if (denom == 0) return 10_000; // if first LP ever, treat as 100% share
        uint256 bps = (uint256(liq) * 10_000) / denom;
        return uint16(bps > 10_000 ? 10_000 : bps);
    }

    function _doPoolMint(MintParams calldata p) internal returns (uint256 amount0, uint256 amount1) {
        // data can encode payer if the pool/callee expects callbacks; keep empty if not used
        bytes memory data = abi.encode(p.payer);
        (amount0, amount1) = ILPPPool(p.pool).mint(
            p.recipient, p.tickLower, p.tickUpper, p.liquidity, data
        );
    }

    function _settleSurcharge(
        address payer,
        address pool,
        uint256 amt0,
        uint256 amt1,
        uint8 tier,
        address lp
    ) internal {
        uint256 rBps = uint256(rebateBps[tier]);
        uint256 kBps = uint256(retentionBps[tier]);

        address t0 = ILPPPool(pool).token0();
        address t1 = ILPPPool(pool).token1();

        uint256 rb0 = (amt0 * rBps) / 10_000;
        uint256 rb1 = (amt1 * rBps) / 10_000;
        uint256 kt0 = (amt0 * kBps) / 10_000;
        uint256 kt1 = (amt1 * kBps) / 10_000;

        if (rb0 > 0) {
            require(IERC20Minimal(t0).transferFrom(payer, vault, rb0), "rb0 transfer failed");
            emit RebatePaid(lp, pool, t0, rb0, tier);
        }
        if (rb1 > 0) {
            require(IERC20Minimal(t1).transferFrom(payer, vault, rb1), "rb1 transfer failed");
            emit RebatePaid(lp, pool, t1, rb1, tier);
        }
        if (kt0 > 0) {
            require(IERC20Minimal(t0).transferFrom(payer, treasury, kt0), "kt0 transfer failed");
            emit Retained(pool, t0, kt0, tier);
        }
        if (kt1 > 0) {
            require(IERC20Minimal(t1).transferFrom(payer, treasury, kt1), "kt1 transfer failed");
            emit Retained(pool, t1, kt1, tier);
        }
    }
}