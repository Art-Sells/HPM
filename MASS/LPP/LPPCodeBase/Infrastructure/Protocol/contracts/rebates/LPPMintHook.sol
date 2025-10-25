// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.20;

import "./interfaces/IERC20.sol";
import "./interfaces/ILPPPoolMinimal.sol";
import "./interfaces/ILPPMintHook.sol";

/// V0 "surcharge" model: user mints full liquidity; in lppMintCallback we:
/// - pay owed amounts to the pool, and
/// - pull surcharge (rebate + retention) from payer to vault/treasury.
/// No storage cache is used; data is encoded and decoded in the callback.
contract LPPMintHook is ILPPMintHook, ILPPPoolMintCallback {
    address public owner;
    address public rebateVault;
    address public treasury;

    // thresholds in bps of share-of-TVL (post-mint approx using pre-mint TVL)
    // tiers: 0..3, where tier 3 is ">= last threshold"
    uint16[4] public shareThresholdBps = [500, 1000, 2000, 5000]; // 5%, 10%, 20%, 50%
    uint16[4] public rebateBps        = [100, 180, 250, 350];     // 1.0%, 1.8%, 2.5%, 3.5%
    uint16[4] public retentionBps     = [50,  90,  125, 175];     // 0.5%, 0.9%, 1.25%, 1.75%

    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);
    event VaultUpdated(address indexed oldVault, address indexed newVault);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    event Qualified(address indexed lp, address indexed pool, uint8 tier, uint16 shareBps);
    event RebatePaid(address indexed lp, address indexed pool, address indexed token, uint256 amount, uint8 tier);
    event Retained(address indexed pool, address indexed token, uint256 amount, uint8 tier);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _rebateVault, address _treasury) {
        owner = msg.sender;
        rebateVault = _rebateVault;
        treasury = _treasury;
    }

    function setOwner(address _owner) external onlyOwner {
        emit OwnerUpdated(owner, _owner);
        owner = _owner;
    }

    function setRebateVault(address _vault) external onlyOwner {
        emit VaultUpdated(rebateVault, _vault);
        rebateVault = _vault;
    }

    function setTreasury(address _treasury) external onlyOwner {
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    function setTiers(
        uint16[4] calldata _shareThresholdBps,
        uint16[4] calldata _rebateBps,
        uint16[4] calldata _retentionBps
    ) external onlyOwner {
        shareThresholdBps = _shareThresholdBps;
        rebateBps = _rebateBps;
        retentionBps = _retentionBps;
    }

    function mintWithRebate(MintParamsLiquidity calldata p)
        external
        returns (uint256 amount0, uint256 amount1, uint8 tier, uint16 shareBps)
    {
        require(p.pool != address(0), "pool=0");
        require(p.recipient != address(0), "recipient=0");
        require(p.payer != address(0), "payer=0");
        require(p.liquidity > 0, "liq=0");

        ILPPPool pool = ILPPPool(p.pool);

        // shareBps ≈ liq / (liq + L0) in basis points (0..10000)
        uint256 L0 = pool.liquidity();
        shareBps = uint16((uint256(p.liquidity) * 10_000) / (uint256(L0) + uint256(p.liquidity)));

        tier = _tierOf(shareBps);
        (uint16 rBps, uint16 kBps) = _bpsForTier(tier);

        emit Qualified(p.recipient, p.pool, tier, shareBps);

        // pass minimal context; tokens are fetched from msg.sender in callback
        bytes memory data = abi.encode(p.payer, p.recipient, tier, rBps, kBps);

        (amount0, amount1) = pool.mint(p.recipient, p.tickLower, p.tickUpper, p.liquidity, data);
    }

    function lppMintCallback(int256 amount0Owed, int256 amount1Owed, bytes calldata data) external override {
        (address payer, address lp, uint8 tier, uint16 rBps, uint16 kBps) =
            abi.decode(data, (address, address, uint8, uint16, uint16));

        address pool = msg.sender;

        // --- token0 path (scoped to keep stack shallow) ---
        {
            address t0 = ILPPPool(pool).token0();
            uint256 o0 = amount0Owed > 0 ? uint256(amount0Owed) : 0;
            if (o0 > 0) {
                _pullPay(payer, t0, pool, o0); // pay pool first

                uint256 rebate0 = (o0 * rBps) / 10_000;
                if (rebate0 > 0) {
                    _pullPay(payer, t0, rebateVault, rebate0);
                    emit RebatePaid(lp, pool, t0, rebate0, tier);
                }

                uint256 keep0 = (o0 * kBps) / 10_000;
                if (keep0 > 0) {
                    _pullPay(payer, t0, treasury, keep0);
                    emit Retained(pool, t0, keep0, tier);
                }
            }
        }

        // --- token1 path (separate scope to drop prior locals) ---
        {
            address t1 = ILPPPool(pool).token1();
            uint256 o1 = amount1Owed > 0 ? uint256(amount1Owed) : 0;
            if (o1 > 0) {
                _pullPay(payer, t1, pool, o1); // pay pool first

                uint256 rebate1 = (o1 * rBps) / 10_000;
                if (rebate1 > 0) {
                    _pullPay(payer, t1, rebateVault, rebate1);
                    emit RebatePaid(lp, pool, t1, rebate1, tier);
                }

                uint256 keep1 = (o1 * kBps) / 10_000;
                if (keep1 > 0) {
                    _pullPay(payer, t1, treasury, keep1);
                    emit Retained(pool, t1, keep1, tier);
                }
            }
        }
    }

    function _pullPay(address from, address token, address to, uint256 amt) internal {
        if (amt == 0) return;
        require(IERC20(token).transferFrom(from, to, amt), "transferFrom failed");
    }

    function _tierOf(uint16 share) internal view returns (uint8 tier) {
        if (share < shareThresholdBps[0]) return 0;
        if (share < shareThresholdBps[1]) return 1;
        if (share < shareThresholdBps[2]) return 2;
        return 3;
    }

    function _bpsForTier(uint8 tier) internal view returns (uint16 rebate_, uint16 retention_) {
        rebate_ = rebateBps[tier];
        retention_ = retentionBps[tier];
    }
}