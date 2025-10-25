# LPPv1 Infrastructure — Blueprint (Restructured)

> Focus: **ship MEV‑as‑LP rebates first**. External USD oracle adapter & atomic `recenterAndMint` are **deferred** (not blockers).

## Progress Checklist

- [x] Dismantle and rebuild [Protocol](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Protocol) & [Periphery](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Periphery): **Complete**
- [x] Configure and compile [Protocol](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Protocol) & [Periphery](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Periphery): **Complete**
- [x] Enable & test **fee = 0** tier in Factory; add **fee=0 math tests** — **Complete**: [LPPZeroFeeSpec](https://github.com/Art-Sells/HPM/blob/main/MASS/LPP/LPPCodeBase/Infrastructure/Protocol/test/LPPFactory.spec.ts)
- [x] Test all other tests inside Protocol & Periphery folders — **Complete**
  - [x] Delete all **snapshots**, recompile and re‑test Periphery and Protocol — **Complete**
- [ ] **Implement MEV‑as‑LP rebates** (in‑kind, diminishing returns) with **LPP retention**  ← **In Progress**
  - [ ] Wire periphery mint wrapper (**LPPMintHook**) to compute rebates & retentions
  - [ ] Deploy **LPPRebateVault** & **LPPTreasury**; set roles
  - [ ] Add **tier math** (share‑of‑TVL → rebate/retention bps)
  - [ ] Emit events; index in Subgraph; spec tests
- [ ] Frontend/API: router prefers **A/B/C (0‑fee)**, metrics & drift badge
- [ ] Tests: zero‑fee invariants, range flips, oracle failure stubs, **rebate logic**
- [ ] **Create 3 pools** (cbBTC/USDC, fee=0) & **initialize** near reference price
- [ ] **Seed liquidity**: tight **primary** range + tiny **fallback** range for each pool
- [ ] Discovery: contract **verification**, **Subgraph**, `RebalanceNeeded` event, **Solver Kit**
- [ ] Deploy to Base, verify, publish docs, announce to searchers

### Deferred (Optional, not required to ship rebates)
- [ ] **LPPOracleAdapter** (USD oracle with staleness & deviation guards) — *deferred*
- [ ] **LPPRouter.recenterAndMint()** (atomic re‑center + mint) — *deferred*

---

## 1. Protocol & Periphery
Core factory/pool/periphery wiring in place. Zero‑fee trading tier enabled; protocol fee paths inert at fee=0.

## 2. MEV‑as‑LP Rebates 
Rebates are paid **in‑kind** from minted notional; platform keeps a **retention** slice.

**Tiering by share of TVL `S` (post‑mint):**

| Tier | S (share of TVL) | **LP Rebate** | **LPP Retention** |
|-----:|------------------:|:-------------:|:-----------------:|
| T1   | 5% – <10%         | 1.0%          | 0.5%              |
| T2   | 10% – <20%        | 1.8%          | 0.9%              |
| T3   | 20% – <35%        | 2.5%          | 1.25%             |
| T4   | ≥50% (cap)        | 3.5%          | 1.75%             |

**Guards**
- Centered‑only (±δ ticks); vesting/hold window; per‑epoch & per‑address caps; rate‑limit.  
- Max tier clamp to prevent dominance games.  
- Zero‑fee trading must remain invariant (no fee growth paths).

### Contracts
- **LPPMintHook** (periphery)
  - `mintWithRebate(MintParams)` → computes `S`, selects tier, skims `(rebate + retention)` in‑kind, mints position with remainder.
  - Emits `Qualified(lp, pool, tier, shareBps)`.
- **LPPRebateVault**
  - Holds rebate liquidity (optional top‑ups); `payRebate(to, token, amount)`; emits `RebatePaid`.
- **LPPTreasury**
  - Receives **retention** slice (for ops/POL).

**Minimal Pool Touches**
- None required for trading math; pool remains unaware of rebates.  
- If desired, add a **factory registry** for `LPPMintHook` allow‑list.

### Math (in‑kind skim)
Given desired deposit `(amount0Desired, amount1Desired)` and computed `(rebateBps, retentionBps)`:
```
skimBps = rebateBps + retentionBps
amount0Mint = amount0Desired * (10_000 - skimBps) / 10_000
amount1Mint = amount1Desired * (10_000 - skimBps) / 10_000

rebate0 = amount0Desired * rebateBps    / 10_000
rebate1 = amount1Desired * rebateBps    / 10_000
keep0   = amount0Desired * retentionBps / 10_000
keep1   = amount1Desired * retentionBps / 10_000
```
Edge: enforce minimums so tiny mints don’t over‑round. Tests cover rounding toward LP.

### Events (indexable)
- `Qualified(address lp, address pool, uint8 tier, uint256 shareBps)`  
- `RebatePaid(address to, address pool, address token, uint256 amount, uint8 tier)`

---

## 3. Frontend/API
- Router prefers **0‑fee** pools A/B/C.  
- Show **drift badge** (pool vs reference price; can use internal TWAP or stub until external oracle is added).  
- `/state` endpoint lists `{ pool, tick, sqrtP, liquidity }` and suggested mint widths.

---

## 4. Tests
- **Rebate tiers** across boundaries; rounding; vest/hold; cap & rate‑limit.  
- **Zero‑fee invariants**: `feeGrowthGlobal{0,1}X128 == 0`.  
- **Range flips** and tick boundary stress.  
- **Oracle failure stubs**: ensure system tolerates missing USD adapter (deferred).

---

## 5. Create & Initialize Three Pools (fee=0)
- `token0 = cbBTC (8d)`, `token1 = USDC (6d)`  
- `factory.createPool(token0, token1, 0)` and `pool.initialize(sqrtPriceX96)` near reference price.  
- Use periphery helpers to mint positions.

**Seed plan**
- **Primary**: ultra‑narrow (±1–2 ticks).  
- **Fallback**: tiny, wide, to avoid no‑liq edges.  
- Offsets at seed (example): A −10 bps, B −5 bps, C +15 bps.

---

## 6. Discovery & Solver Adoption
- Verify contracts; publish **Subgraph**.  
- Emit `RebalanceNeeded(int256 driftBps)` from monitoring jobs.  
- Provide **Solver Kit** (TS/Foundry) + Docker example.

---

## 7. Deployment (Base)
1. Deploy Factory; `enableFeeAmount(0, tickSpacing=5)`  
2. Deploy periphery (router + mint hook)  
3. Deploy **LPPRebateVault**/**LPPTreasury**, set roles  
4. Create Pools A/B/C; initialize; seed primary/fallback  
5. Verify, publish Subgraph & docs; announce
