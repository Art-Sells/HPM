# LPP Infrastructure v1 Blueprint

## Scope & Principles:

- **MCV (Maximum Contributing Value)** applies **only** to LPs who mint liquidity in equal proportions of **USDC + asset**.  
- **Approved Supplicators** are external actors authorized by Treasury to rebalance pools but **earn no rebate**.  
- **Supplicate (rebalance)** can be called **only** by LP-MCVs or Treasury-approved Supplicators.  
- **Rebates and retentions** apply **only** during the mint process.  

---

### A) Roles & Permissions
- **LP-MCV (MCV)**  
  - Mints liquidity via LPP periphery with equal USDC & asset.  
  - Eligible for **rebate + retention** skim during mint.  
  - Automatically allowed to call `supplicate`.  
- **Approved Supplicator**  
  - Explicitly authorized by Treasury to call `supplicate` without LP position.  
  - No MCV status, no rebates.  

✅ **Supplicate permission = (is LP-MCV) OR (is Approved Supplicator)**  
✅ **Rebates apply only to LP-MCV minting**

---

### B) Rebate & Retention Tiers (for LP-MCVs only)

| Tier | Share of TVL S | Rebate (%) | Retention (%) |
|:----:|:---------------:|:-----------:|:--------------:|
| T1 | 5 – < 10 | 1.0 | 0.5 |
| T2 | 10 – < 20 | 1.8 | 0.9 |
| T3 | 20 – < 35 | 2.5 | 1.25 |
| T4 | ≥ 50 (cap) | 3.5 | 1.75 |

**Guards**  
- Centered mint window (± δ%), vest / hold periods, per-epoch caps, tier clamp.

---

### C) Core Flows

#### LP-MCV Mint
1. Caller executes `mintWithRebate(equal USDC, equal asset)`  
2. MintHook computes tier, applies rebate + retention skim, mints remainder.  
3. Rebate sent to LP-MCV, retention to Treasury.  
4. Caller becomes LP-MCV (eligible to supplicate).  

#### Supplication (Rebalance)
- Callable only by LP-MCV or Approved Supplicator.  
- Router fetches live quote from `LPPSupplicationQuoter` → executes atomic rebalance using `LPPPool`.  
- Emits `SupplicateExecuted`.

#### Quoting (View-Only Flow)
- Any address (frontend, solver, or analytics) can call `LPPSupplicationQuoter.quoteSupplication(pool, direction, amountIn)`  
- Returns potential output, price impact, and drift metrics before committing capital.  

---

## Progress Checklist

### 1. Core Contracts to Build

- [ ] **`LPPFactory`**  
  - Creates & registers new `LPPPool` instances.  
  - Stores configuration metadata (tick range spacing, asset types, etc.).  
  - Exposes registry lookups for Router and MintHook.

- [ ] **`LPPPool`**  
  - Core liquidity container holding USDC and asset reserves.  
  - Tracks liquidity positions, pricing function, and pool math (independent of fee growth).  
  - Interface for mint / burn / quote / supplicate operations.

- [ ] **`LPPMintHook`**  
  - Validates **equal-value deposits** (USDC : asset within 0.10 % tolerance).  
  - Calculates total TVL share → selects tier → applies in-kind skim:  
    - `rebate` → to LP-MCV  
    - `retention` → to Treasury  
  - Emits:  
    - `MCVQualified(lp, pool, tier, shareBps)`  
    - `MCVRebatePaid(to, pool, token, amount, tier)`

- [ ] **`LPPAccessManager`**  
  - Registry of Treasury-approved Supplicators.  
    - `approvedSupplicator[address] → bool`  
  - Emits `SupplicatorApproved(address who, bool approved)`

- [ ] **`LPPTreasury`**  
  - Owns AccessManager.  
  - Receives retention slices from MintHook.  
  - Manages epoch caps, vest periods, and distribution policies.

- [ ] **`LPPRebateVault`**  
  - Holds in-kind rebates for LP-MCVs.  
  - Handles vesting, unlocking, and distribution.

- [ ] **`LPPSupplicationQuoter`**  
  - Simulates a supplication (rebalance) **without execution**.  
  - Inputs: `pool`, `amountIn`, `direction (asset→USDC or USDC→asset)`  
  - Outputs: `expectedAmountOut`, `impactRatio`, `liquidityBefore/After`, and `priceDrift`.  
  - Used by Router, Frontend, and off-chain solvers to estimate outcomes.  
  - Emits no state change; pure view logic.  

- [ ] **`LPPRouter`**  
  - Executes verified `supplicate(SupplicateParams)` transactions.  
  - Checks:  
    - Caller is LP-MCV **or** Approved Supplicator.  
  - Optionally calls `LPPSupplicationQuoter` for pre-validation.  
  - Emits `SupplicateExecuted(caller, pool, assetIn, amountIn, assetOut, amountOut, reason)`.

### 2. Testing Plan (with Snapshots)

#### Unit Tests
- [ ] Rebate / retention math precision.  
- [ ] Equal-value enforcement thresholds.  
- [ ] Access gating: LP-MCV ✅, Approved ✅, Unauthorized ❌.  
- [ ] Revocation enforcement.  
- [ ] Vesting and epoch cap logic.  
- [ ] Pool math integrity (price and reserve correctness).  
- [ ] Callback / reentrancy safety.  
- [ ] Quoter accuracy: simulated vs. executed deltas.  

#### Integration Tests
- [ ] Bootstrap tiny liquidity → rebate + retention flows.  
- [ ] LP-MCV supplicate success path.  
- [ ] Approved Supplicator supplicate success.  
- [ ] Unauthorized caller fails.  
- [ ] Treasury retention accounting.  
- [ ] Vesting unlock & withdrawal sequence.  

#### Snapshots (Hardhat)
| ID | Stage | Description |
|----|--------|-------------|
| `S1` | Bootstrap | Factory + pools deployed & initialized |
| `S2` | First Mint (MCV) | Equal-value mint with Tier-1 rebate |
| `S3` | First Supplicate (MCV) | LP-MCV executes rebalance |
| `S4` | First Supplicate (Approved) | Treasury-approved address executes rebalance |
| `S5` | Revocation Guard | Revoked Supplicator reverted |
| `S6` | Quoter Validation | Compare quoter output vs. actual execution results |

Each snapshot logs pool state, liquidity, vault balances, treasury holdings, and router state.

---

### 3. Simulation & Bot Testing
- [ ] **Fork MEV bot repos** and repurpose for MCV analysis:  
  - Simulate arbitrage / rebate opportunities under LPP rules.  
  - Start with micro-liquidity and gradually scale to full capacity.  
  - Observe how rebates and retentions interact with price stabilization.  
  - Derive potential **new revenue model** if rebate structure sustains arbitrage cycles.

---

### 4. Subgraph & Events
- [ ] Index:  
  - `MCVQualified`, `MCVRebatePaid`, `SupplicatorApproved`, `SupplicateExecuted`, `RebalanceNeeded`.  
- [ ] Add Quoter view calls for external analytics (no event emission).  
- [ ] Entities: Pool, Position, LPmcv, Supplicator, RebateEpoch, TreasuryReceipt, QuoteSnapshot, SupplicateAction.  

---

### 5. Frontend / API
- [ ] Router auto-selects optimal LPP pools.  
- [ ] Badge system: LP-MCV / Approved Supplicator / Unauthorized.  
- [ ] Live **Quoter** integration: pre-display expected output + drift metrics.  
- [ ] `/state` endpoint: `{ pool, price, liquidity, TVL, positions, rebateTier }`.  

---

### 6. Deployment Plan
- [ ] Deploy Factory → register pool templates.  
- [ ] Deploy Treasury + AccessManager + RebateVault (wire roles).  
- [ ] Deploy Periphery: MintHook, Router, Quoter.  
- [ ] Create asset/USDC pools A, B, C → initialize at reference price.  
- [ ] Seed equal USDC & asset liquidity.  
- [ ] Verify contracts, index Subgraph, launch dashboards, publish docs.  