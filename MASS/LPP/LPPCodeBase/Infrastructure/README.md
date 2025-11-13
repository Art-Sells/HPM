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

### 1. Core Contracts to Build: ***completed and being refactored***

- [X] **`LPPFactory`**  
  - Creates & registers new `LPPPool` instances.  
  - Stores configuration metadata (tick range spacing, asset types, etc.).  
  - Exposes registry lookups for Router and MintHook.

- [X] **`LPPPool`**  
  - Core liquidity container holding USDC and asset reserves.  
  - Tracks liquidity positions, pricing function, and pool math (independent of fee growth).  
  - Interface for mint / burn / quote / supplicate operations.

- [X] **`LPPMintHook`**  
  - Validates **equal-value deposits** (USDC : asset within 0.10 % tolerance).  
  - Calculates total TVL share → selects tier → applies in-kind skim:  
    - `rebate` → to LP-MCV  
    - `retention` → to Treasury  
  - Emits:  
    - `MCVQualified(lp, pool, tier, shareBps)`  
    - `MCVRebatePaid(to, pool, token, amount, tier)`

- [X] **`LPPAccessManager`**  
  - Registry of Treasury-approved Supplicators.  
    - `approvedSupplicator[address] → bool`  
  - Emits `SupplicatorApproved(address who, bool approved)`

- [X] **`LPPTreasury`**  
  - Owns AccessManager.  
  - Receives retention slices from MintHook.  
  - Manages epoch caps, vest periods, and distribution policies.

- [X] **`LPPRebateVault`**  
  - Holds in-kind rebates for LP-MCVs.  
  - Handles vesting, unlocking, and distribution.

- [X] **`LPPSupplicationQuoter`**  
  - Simulates a supplication (rebalance) **without execution**.  
  - Inputs: `pool`, `amountIn`, `direction (asset→USDC or USDC→asset)`  
  - Outputs: `expectedAmountOut`, `impactRatio`, `liquidityBefore/After`, and `priceDrift`.  
  - Used by Router, Frontend, and off-chain solvers to estimate outcomes.  
  - Emits no state change; pure view logic.  

- [X] **`LPPRouter`**  
  - Executes verified `supplicate(SupplicateParams)` transactions.  
  - Checks:  
    - Caller is LP-MCV **or** Approved Supplicator.  
  - Optionally calls `LPPSupplicationQuoter` for pre-validation.  
  - Emits `SupplicateExecuted(caller, pool, assetIn, amountIn, assetOut, amountOut, reason)`.

### 2. Testing Plan (with Snapshots): ***in progress***

#### Unit Tests
- [X] Rebate / retention math precision.  
- [X] Equal-value enforcement thresholds.  
- [X] Access gating: LP-MCV supplicators & minting, Approved Treasury supplicators, Treasury pool bootstrapping aothorizations only... Everyone else Unauthorized... Only using Private Key from LP Treasury
- [X] Revocation enforcement.  
- [X] Vesting and epoch cap logic.  
- [X] Pool math integrity (price and reserve correctness).  
- [X] Callback / reentrancy safety.  
- [X] Quoter accuracy: simulated vs. executed deltas.  

#### Integration Tests
- [X] Bootstrap tiny liquidity → rebate + retention flows.  
- [X] LP-MCV supplicate success path.  
- [X] Approved Supplicator supplicate success.  
- [X] Unauthorized caller fails.  
- [X] Treasury retention accounting.  
- [X] Vesting unlock & withdrawal sequence. 

##### Snapshots (Hardhat)
| Stage | Description |
|--------|-------------|
| Bootstrap | Factory + pools deployed & initialized |
| Mint (MCV) | Equal-value mint with Tier-1 rebate |
| Supplicate (MCV) | LP-MCV executes rebalance |
| Supplicate (Approved) | Treasury-approved address executes rebalance |
| Revocation Guard | Revoked Supplicator reverted |
| Quoter Validation | Compare quoter output vs. actual execution results |

Each snapshot logs pool state, liquidity, vault balances, treasury holdings, and router state.

#### Simulation & Bot Testing
- [ ] **Fork MEV bot repos** to test if they will discover LPP (refer to guide/LPPsimulations.md)
  - Simulate arbitrage / rebate opportunities under LPP rules.  
  - Start with micro-liquidity and gradually scale to full capacity.  
  - Observe how rebates and retentions interact with price stabilization.  
  - Derive potential **new revenue model** if rebate structure sustains arbitrage cycles.
  - [ ] If the above works, find a way to remove humans and make it completely autonomous (AI) where (only) the bots store and access private keys, can withdraw and deposit funds, etc (thus creating the first ever AI self-sustaining economy).
  - if that^ works, keep and delete all "y.|_|", if not, reconfigure.
- [ ] Test all (and add more edge cases to drain pools/vaults) with malicious ERC20 smart contract code/etc from security/SecurityHardening.md, then add guardrails to failing tests.
- [ ] Retest all spec tests then retest MEV (trading) bot repo then Re-test...  

---

### 3. Subgraph & Events
- [ ] Index:  
  - `MCVQualified`, `MCVRebatePaid`, `SupplicatorApproved`, `SupplicateExecuted`, `RebalanceNeeded`.  
- [ ] Add Quoter view calls for external analytics (no event emission).  
- [ ] Entities: Pool, Position, LPmcv, Supplicator, RebateEpoch, TreasuryReceipt, QuoteSnapshot, SupplicateAction.  

---

### 4. Frontend / API
- [ ] Router auto-selects optimal LPP pools.  
- [ ] Badge system: LP-MCV / Approved Supplicator / Unauthorized.  
- [ ] Vesting (API) and approving contract addresses with Treasury Address, test...
- [ ] Live **Quoter** integration: pre-display expected output + drift metrics.  
- [ ] `/state` endpoint: `{ pool, price, liquidity, TVL, positions, rebateTier }`.  

---

### 5. Deployment Plan
- [ ] Delete TestERC20 contract
- [ ] Deploy on Testnet first (get treasury address and key), test USDC/ASSET using LPP first... if it works... Deploy on Mainnet
- [ ] Create asset/USDC pools A, B, C → initialize at reference price.  
- [ ] Seed equal USDC & asset liquidity.  
- - [ ] Bootstrap seeding dynamics
- - Equal seed for all pools (via adapter):
- - - Pool A: USDC = $1, cbBTC ≈ $1 (≈ 0.001 cbBTC)*
- - - Pool B: USDC = $1, cbBTC ≈ $1 (≈ 0.001 cbBTC)*
- - - Pool C: USDC = $1, cbBTC ≈ $1 (≈ 0.001 cbBTC)*
- - - - Primary position (each pool): ultra‑narrow (≈ ±1–2 ticks).
Fallback position: tiny, very wide range to prevent “no‑liquidity”.
Mint via NonfungiblePositionManager (wrapped in @/periphery helpers).
- - Center Offsets (relative to oracle at time of seed):
- - - Pool A: −10 bps center
- - - Pool B: −5 bps center
- - - Pool C: +15 bps center
- - Offsetting without an “anchor” intentionally creates internal spreads so external MEV (Trading Bot) can arb and then mint (via the atomic flow below).
- - Test if prices are off-center, if so, then increase pool seeds
- [ ] Verify contracts, index Subgraph, launch dashboards, publish docs.  

