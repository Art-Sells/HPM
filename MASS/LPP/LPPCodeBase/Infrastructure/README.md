# LPP Infrastructure v1 — Phase 0 (No Vesting / No Rebates)

> **Current focus:** Minimal LPP core for MCV testing.

---

## 0. Design Snapshot

### Phase 0 Goals (4 Pools + MEV Testing)

Target behavior for Phase 0:

- **4 pools** with **$2 TVL each**
- **3 pool orbits** with ±500 bps offsets
- **100% of pools within ±400–500 bps of reference price**
- `supplicate`  
  - **Only Treasury-approved addresses**  
  - Simple USDC ⇄ ASSET swaps (rebalancing)  
  - **No fee** at the pool level (pure CFMM)
- `mcvSupplication`  
  - Callable by **anyone**
  - Executes across **3-pool orbit** for USDC ⇄ ASSET cycles
  - **2.5% fee** taken from profitable mcvSupplication that routes automatically into the pool's liquidity  
  - Of that 2.5%: **0.5% retained by Treasury**, **2.0% available to external MEV / searchers** (PnL)

Later, after MEV testing is successful, we scale to:

- **1,000 pools** with ~$2 each
- **400 pool orbits** spanning ±500 bps
- Same basic fee logic (2.5% / 0.5% split), but at LPP-wide scale.

---

## 1. Contracts in Scope for Phase 0

> Only the pieces we actually need for 4 pools + MEV testing.

- [X] **LPPFactory (minimal)**  
  - Create, track, and register `LPPPool` instances.  
  - Store list of pools and basic metadata (asset, usdc).  
  - Enforce:
    - Only Treasury can create pools.
    - Only Treasury can update factory-level parameters (if any).

- [X] **LPPPool (simple CFMM, no rebates)**  
  - Holds **ASSET** and **USDC** reserves.  
  - Core functions:
    - `quoteSupplication(bool assetToUsdc, uint256 amountIn) → (uint256 amountOut, int256 priceDriftBps)`  
    - `supplicate(address payer, address to, bool assetToUsdc, uint256 amountIn, uint256 minAmountOut)`  
  - No hooks, no rebates, no vesting.  
  - Pricing:
    - Minimal x*y-style or your current placeholder CFMM.
    - Track `reserveAsset`, `reserveUsdc`, `priceX96`, `totalLiquidity`.
  - Initialization:
    - `bootstrapInitialize` sets initial reserves and price (including offset in bps per pool).

- [X] **LPPRouter (Phase 0)**  
  - Entry point for both:
    - `supplicate` (Treasury-approved addresses only)
    - `mcvSupplication` (anyone, multi-pool strategy)
  - Responsibilities:
    - Permission checks via `LPPAccessManager` or hard-coded Treasury list.
    - Routing:
      - `supplicate`: Single-pool call to `LPPPool.supplicate`.
      - `mcvSupplication`: Multi-pool route (3-pool orbit), computing path and aggregating result.
    - Fee logic for **mcvSupplication**:
      - Charge **2.5%** on profitable output.
      - Route **0.5%** to Treasury.
      - Keep 2.0% (or configurable share) as MEV/Bot profit.

- [X] **LPPAccessManager (Phase 0)**  
  - [X] Tracks **Treasury-approved supplicators**.
  - [X] Functions:
    - `setApprovedSupplicator(address who, bool approved)`
    - `isApprovedSupplicator(address who) view returns (bool)`
  - Used by Router only for:
    - `supplicate` permission checks.

- [X] **LPPTreasury (Phase 0)**  
  - [X] Holds protocol fees from **mcvSupplication** routes.
  - [X] Owns/controls:
    - Factory
    - AccessManager
  - [X] Core functions:
    - `withdrawERC20(token, to, amount)` (with proper **nonReentrant guard**)  
    - `setApprovedSupplicator(...)` via AccessManager
    - Governance-only controls for future phases.

- [X] **TestERC20 (temporary for local)**  
  - Purely for Hardhat testing of ASSET & USDC.
  - Removed before mainnet deployment.

---

## 2. Phase 0 Pool Topology

### 2.1 Base Reference

- Reference price: 1 ASSET ≈ 1 USDC (for local test simplicity).
- All pools seeded with **$2 TVL** (1 ASSET + 1 USDC in notional terms).

### 2.2 4 Pools, 3 Orbits, Offsets

- [X] **Pools (each with ~2 units of value):**
  - Pool A: **center −500 bps**
  - Pool B: **center −499 bps**
  - Pool C: **center +499 bps**
  - Pool D: **center +500 bps**

- [X] **Orbits (Phase 0):**
  - Orbit 1: A ↔ B
  - Orbit 2: B ↔ C
  - Orbit 3: C ↔ D

- [X] **Constraints:**
  - 100% of pools must remain within **±400–500 bps** from reference.
  - Treated as a tiny “ladder” of internal spreads.

> The future **400 pool orbits** (scaled version) replicate this pattern around a more granular tick ladder.

---

## 3. Core Flows (Phase 0)

### 3.1 `supplicate` (Treasury-approved)

- [X] Callable only by addresses where `isApprovedSupplicator[caller] == true`.
- [X] Execution:
  1. Router verifies caller permission.
  2. Router forwards call to single `LPPPool.supplicate` with:
     - `payer = msg.sender`
     - `to = caller` or specified recipient
     - `assetToUsdc` direction
     - `amountIn`, `minAmountOut`
  3. Pool performs CFMM swap, updates reserves, emits `Supplicate` event.
  4. Router emits `SupplicateExecuted` event with reason code (0 = OK).  
- [X] No rebate, no extra fee.

Use case: **Treasury maintenance** and simple rebalancing, not profit extraction.

---

### 3.2 `mcvSupplication` (Anyone, 3-Pool Orbit)

- [X] Callable by **any address**.
- [X] Execution outline:
  1. Router computes or receives a pre-computed **3-pool path** (e.g., B → C → D → B).  
  2. For each hop in the orbit:
     - Call `LPPPool.supplicate` sequentially, carrying forward the output as the next input.
  3. At the end, compare final balance vs initial:
     - If **no profit**, revert or simply return with zero fee.
     - If **profit > 0**, apply fee:
       - Compute `fee = profit * 2.5%`
       - `treasuryCut = fee * 0.5 / 2.5 = profit * 0.5%`
       - `botProfit = profit - fee + (fee - treasuryCut)` depending on exact model  
         (we can lock this down in code when we wire the MEV bot).

- [X] Example route:
  - Start with 1 USDC in Pool B.
  - B: USDC → ASSET → amountOut1
  - C: ASSET → USDC → amountOut2
  - D: USDC → ASSET → amountOut3
  - Compare `amountOut3` vs starting value; if > start, we realized a profit.

> This is where **Flashbots searcher code** comes in: it will test thousands of possible small routes and only bundle the profitable ones on-chain.

### 3.3 Test Off Chain
- [ ] Test 500 events/day cap...
- [ ] reconfigure all spec tests to test above

---

## 4. MEV / Flashbots Integration (off-chain)

> Focus: prove that *existing MEV searchers* can see & interact with LPP pools using standard CFMM semantics

- [ ] **Clone Flashbots searcher repo (ethers-provider-flashbots-bundle or variant)**  
- [ ] **Add LPP to the search universe:**
  - Test Contract Logic against Flashbots logic (restructure (only smart contract logic) as needed)

---

## 5. MEV / Flashbots Integration (on-chain)

- [ ] **Deploy Smart Contract Logic and prepare logic for searchers... Then watch...**
  - Prepare searcher logic (theGraph, etc)
  - If successful, move onto #6.

---

## 6. Delete / Defer (if above is successful)

- [ ] **Prepare for scale-out phase (1,000 pools / 500 orbits and Treasury can withdraw pool amounts (only) no one else):**
  - Remove daily events/cap
  - Auto-generation of pool ladders around oracle price.
  - Internal orbit registry (-/+500 orbits (all the same)) and lever to turn off pool orbits.
  - Same fee model extended LPP-wide.
  - retest with spec files, add security (test all edge cases) and expand delete all ("you"s)
  
## 7. Prepare to buildPublic indexer & SDK
  - Ship a tiny TS SDK:
	•	quoteAndBuildBundle(startPool, amountIn) → returns totalOut, per-hop out, calldata, gas estimate, & suggested minTotalAmountOut.
	•	Include examples for common builders (Flashbots-style bundles, private RPCs, etc.).
	•	Why: fastest way to 3rd-party adoption.
