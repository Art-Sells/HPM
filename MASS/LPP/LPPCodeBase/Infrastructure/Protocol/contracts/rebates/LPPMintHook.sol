// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.20;

import "./interfaces/IERC20.sol";
import "./interfaces/ILPPPool.sol";
import "./interfaces/ILPPPositionManager.sol";
import "./utils/Ownable.sol";

contract LPPMintHook is Ownable {
    error REBATE_BPS_ZERO();
    error VAULT_ADDR_ZERO();
    error TREASURY_ADDR_ZERO();

    address public vault;      // rebate destination
    address public treasury;   // retention destination

    // tier tables (indices 0..3 correspond to T1..T4)
    uint16[4] public rebateBps;
    uint16[4] public retentionBps;
    uint32[4] public lockSecs; // base lock duration per tier (seconds)

    uint16[4] public shareBreaksBps; // e.g., [1000, 2000, 3500, 5000]

    event Qualified(address indexed lp, address indexed pool, uint8 tier, uint16 shareBps);
    event RebatePaid(address indexed lp, address indexed pool, address token, uint256 amount, uint8 tier);
    event Retained(address indexed pool, address token, uint256 amount, uint8 tier);
    event VaultUpdated(address indexed oldVault, address indexed newVault);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event LockTableUpdated(uint32[4] lockSecs);

    constructor(address _vault, address _treasury) {
        if (_vault == address(0)) revert VAULT_ADDR_ZERO();
        if (_treasury == address(0)) revert TREASURY_ADDR_ZERO();
        vault = _vault;
        treasury = _treasury;
        // sensible defaults (can be updated by owner)
        rebateBps    = [uint16(100), 180, 250, 350];
        retentionBps = [uint16( 50),  90, 125, 175];
        lockSecs     = [uint32(6 hours), 1 days, 3 days, 7 days];
        shareBreaksBps = [1000, 2000, 3500, 5000];
    }

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
        rebateBps = _rebateBps;
        retentionBps = _retentionBps;
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

    function _tierForShareBps(uint16 sBps) internal view returns (uint8) {
        // returns 0..3
        if (sBps < shareBreaksBps[0]) return 0;
        if (sBps < shareBreaksBps[1]) return 1;
        if (sBps < shareBreaksBps[2]) return 2;
        return 3; // >= 3rd break → T4
    }

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
        // NOTE: you already have this logic; keep your computation that yields shareBps
        uint16 shareBps = _computeShareBps(p.pool, p.liquidity); // your existing math
        uint8 tier = _tierForShareBps(shareBps);

        // **New**: MUST pay a non-zero rebate and have a live vault
        if (rebateBps[tier] == 0) revert REBATE_BPS_ZERO();
        if (vault == address(0)) revert VAULT_ADDR_ZERO();

        emit Qualified(p.recipient, p.pool, tier, shareBps);

        // 2) call pool.mint (msg.sender = this hook) → amounts owed returned by event
        (uint256 amt0, uint256 amt1) = _doPoolMint(p);

        // 3) compute rebate & retention; pull surcharge from payer → send to vault/treasury
        (uint256 rb0, uint256 rb1, uint256 rt0, uint256 rt1) = _settleSurcharge(p.payer, p.pool, amt0, amt1, tier);

        // 4) finalize at the manager: this is where we impose the per-tier lock
        tokenId = ILPPPositionManager(_manager()).finalizeMintFromHook(
            p.pool, p.recipient, p.tickLower, p.tickUpper, p.liquidity, tier, lockSecs[tier]
        );
    }

    // ----- your existing helpers for computing share, minting, transferring, etc. -----
    function _computeShareBps(address pool, uint128 liq) internal view returns (uint16) { /* ... */ }
    function _doPoolMint(MintParams calldata p) internal returns (uint256 amount0, uint256 amount1) { /* ... */ }
    function _settleSurcharge(address payer, address pool, uint256 amt0, uint256 amt1, uint8 tier)
        internal returns (uint256 rb0, uint256 rb1, uint256 kt0, uint256 kt1)
    { /* ... */ }

    function _manager() internal view returns (address) { /* return your manager/NFPM address */ }
}