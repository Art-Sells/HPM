<img src="https://github.com/Art-Sells/HPM/blob/main/MASS/LPP/LPPCodeBase/FAFE/FAFE-Logo.png" width="500px"> 

# FAFE: Fully Autonomous Financial Ecosystem — Blueprint

> Delivers a self-funding, permissioned liquidity plane where fixed premiums/discounts, AI arbitrage loops, and a six-pool lattice guarantee deterministic profitability and compounding TVL.

---

## 1. Scope

- **Deterministic premiums/discounts.** Every swap enforces a ±5,000 bps offset, yielding exactly 1.5× (premium) or 0.5× (discount) of the base CFMM quote until the relevant reserve is depleted.
- **Six-pool lattice.** Three negative-offset pools (−5,000 bps) and three positive-offset pools (+5,000 bps) provide a fixed ladder of subsidized trades that our AI can harvest and refill.
- **AI-driven loop.** A privileged agent borrows USDC/cbBTC, purchases discounted cbBTC/USDC on FAFE, dumps it at external market, recycles profits into treasury-controlled pools, and rebalances offsets automatically.
- **Single-source of truth.** Deployment manifests, pool manifests, snapshots, scripts, and guides all live in this repo; there is no hidden state.
- **Permissioned surface.** `supplicate` is gated by `FAFEAccessManager`. Only whitelisted operators (e.g., `MASS_TESTER_ADDRESS`) can tap the subsidized pools.

Everything in this project now speaks FAFE terminology—filenames, contract types, env vars, and documentation.

---

## 2. Contract Architecture

| Component | Solidity File | Responsibility |
| --- | --- | --- |
| **FAFEAccessManager** | `contracts/FAFEAccessManager.sol` | Stores approved supplicators, exposes `setApprovedSupplicator` / `isApprovedSupplicator`. |
| **FAFETreasury** | `contracts/FAFETreasury.sol` | Owns factory/access/router, performs `bootstrapViaTreasury`, fee custody, and governance actions. |
| **FAFEFactory** | `contracts/FAFEFactory.sol` | Mints `FAFEPool` instances (ASSET/USDC), enforces treasury-only creation, tracks metadata. |
| **FAFEPool** | `contracts/FAFEPool.sol` | Holds reserves, applies ±5,000 bps multipliers via `_quoteAmount`, clamps payouts to inventory, exposes `supplicate`/`quote`. |
| **FAFERouter** | `contracts/FAFERouter.sol` | Entry point for `supplicate`, handles access control, aggregates events, and wires per-hop accounting. Multi-hop MCV logic has been removed. |
| **FAFESupplicationQuoter** | `contracts/FAFESupplicationQuoter.sol` | Off-chain helper mirroring router math for bots/tests. |
| **IFAFE*** | `contracts/interfaces/` | Canonical interfaces for external integrations (access manager, factory, pool, router, treasury, quoter). |
| **Libraries** | `contracts/libraries/FullMath.sol`, `FixedPointMath.sol` | Deterministic mul/div helpers used by `_quoteAmount`. |

**Key rename rule:** every prior `LPP*` symbol/file/ABI is now `FAFE*`. Update your imports and TypeChain references accordingly.

---

## 3. Six-Pool Topology & Premium Mechanics

FAFE maintains six pools with fixed offsets: three negative-offset pools (−5,000 bps) and three positive-offset pools (+5,000 bps). Each swap applies the offset after execution from a single pool.

| Pool ID | Offset (bps) | Trade Direction | Multiplier | Notes |
| --- | --- | --- | --- | --- |
| `P₁` | −5,000 | USDC → ASSET | 1.5× baseOut | Drains cbBTC quickly; inventory capped at seeded amount. |
| `P₂` | −5,000 | USDC → ASSET | 1.5× | Mirror of `P₁` for load spreading. |
| `P₃` | −5,000 | USDC → ASSET | 1.5× | Third slot for redundancy/parallel borrowing. |
| `P₄` | +5,000 | ASSET → USDC | 1.5× baseOut | Provides USDC premiums when selling cbBTC. |
| `P₅` | +5,000 | ASSET → USDC | 1.5× | Mirror of `P₄`. |
| `P₆` | +5,000 | ASSET → USDC | 1.5× | Third slot. |

**Base math:**

```
baseOut = amountIn * reserveOpp / reserveIn
multiplier = (10_000 ± offsetBps) / 10_000
amountOut = min(baseOut * multiplier, reserveOpp)
```

An ASCII sketch of the lattice (or opposite for "drain USDC")

```
 USDC ----(−5k)----> [P1] === [P2] === [P3] ----(drain cbBTC)
   ^                                             |
   |                                             v
  Ai loops <-----(+5k, sell cbBTC)----- [P4]=[P5]=[P6]
```

Each `FAFEPool` applies its offset after each swap. Offsets remain fixed per pool.

---

## 4. AI Replenishment Loop & Treasury Ops

1. **Swap from negative-bps pools.** Borrow up to 1% of each negative-bps pool's USDC via authorized `swap` calls. Because of −5,000 bps offsets, the AI receives ~1.5× the base CFMM output in cbBTC until the pool runs dry.
2. **Swap from positive-bps pools.** Borrow up to 1% of each positive-bps pool's cbBTC via authorized `swap` calls. Because of +5,000 bps offsets, the AI receives ~1.5× the base CFMM output in USDC until the pool runs dry.
3. **Sell externally.** Dump cbBTC/USDC on spot venues pegged to median oracle prices to realize immediate profit.
4. **Return principal + profit.** Refill pools through `FAFETreasury` donations, maintaining reserves for both negative-bps and positive-bps pools.
5. **Rebalance.** If reserves become imbalanced, call treasury hooks (or dedicated rebalancer scripts) to auto-purchase assets and reinitialize pools at the correct offsets.
6. **Repeat.** Because premiums are deterministic and available in both directions (cbBTC and USDC), cycling this loop continuously compounds treasury TVL while keeping external participants blinded to the subsidy.

Treasury automation scripts (`scripts/run-fafe-flow.ts`, forthcoming AI controllers) encapsulate these steps and emit JSON snapshots under `test/Deployment/__snapshots__` for auditing.

---

## 6. Deployment & Testing Workflow

1. **Install deps & generate types**
   ```bash
   pnpm install   # or npm install
   npx hardhat compile
   ```
2. **Run contract/test suites** (post-rename):
   ```bash
   npx hardhat test test/PoolMath.spec.ts
   npx hardhat test test/AccessGating.Supplicate.spec.ts
   npx hardhat test test/Deployment/*.spec.ts  # future FAFE suites
   ```

3. **Deploy to Base mainnet** with verbose logging:
   ```bash
   LOG_FILE=logs/deploy-$(date +%Y%m%d-%H%M%S).log \
   npx hardhat run scripts/deploy.ts --network base 2>&1 | tee "$LOG_FILE"
   ```
   The script now:
   - Uses `FAFE*` contract names.
   - Emits timestamped steps (access deploy, treasury transfer, manifest write).
4. **Seed & test a FAFE pool:**
   ```bash
   FAFE_ASSET_AMOUNT=0.000012 \
   FAFE_USDC_AMOUNT=0.5 \
   FAFE_SUPPLICATE_USDC=0.5 \
   npx hardhat run scripts/fund-treasury.ts --network base

   npx hardhat run scripts/run-fafe-flow.ts --network base
   ```
   This builds a new −5,000 bps pool, approves `MASS_TESTER`, runs a 0.5 USDC `supplicate`, and writes `fafe-*-supplicate` snapshots under `test/Deployment/__snapshots__/`.
5. **Manifests & snapshots**
   - `deployment-manifest.json`: latest FAFE contract addresses.
   - `test/Deployment/pool-manifest.json`: known pools with offsets.
   - `test/Deployment/__snapshots__`: canonical pre/post states for CI assertions.

---

## 7. Monitoring & Next Steps

- **Runtime telemetry:**
  - `OffsetFlipped`, `Swap`, and treasury donations for Grafana ingestion.
  - `scripts/read-onchain-prices.ts` remains the lightweight sanity check for reserve/price drift.
- **AI + treasury dashboards:** integrate logs from `run-fafe-flow` and future AI controllers into Arells’ monitoring stack (Notion/Kibana) to track TVL, premium capture, and refill cadence.
- **Security & scale:**
  - Expand spec coverage (reentrancy, pause paths, daily-cap removal).
  - Prepare for 6→N pool scaling by parameterizing `FAFEFactory` and `FAFETreasury` with offset templates.
  - Document upgrade procedures and incident response and prepare for main re-deployment (create new TreasuryOperator/Address/Key save it outside .env)

## 8. Re-write HPM/MASS/LPP Readmes

- Rewrite all returns in bull/bear markets (including graphs) to fit FAFE dynamics.

With FAFE, every piece of code, documentation, and operational workflow exists to support the autonomous premium-harvesting loop (LPP). Keep the manifests current, enforce access controls, and the system remains a self-funding liquidity engine.
