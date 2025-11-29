<img src="https://github.com/Art-Sells/HPM/blob/main/MASS/LPP/LPPCodeBase/FAFE/FAFE-Logo.png" width="500px"> 

# FAFE: Fully Autonomous Financial Ecosystem — Blueprint

> Delivers a self-funding, permissioned liquidity plane where fixed premiums/discounts, AA arbitrage loops, and a six-pool lattice guarantee deterministic profitability and compounding TVL.

---

## 1. Scope

- **Deterministic premiums/discounts.** Every swap enforces a ±5,000 bps offset, yielding exactly 1.5× (premium) or 0.5× (discount) of the base CFMM quote with output clamped to available reserves. The AA continuously refills pools through the arbitrage loop, ensuring premiums remain available.
- **Six-pool lattice.** Three negative-offset pools (−5,000 bps) and three positive-offset pools (+5,000 bps) provide a fixed ladder of subsidized trades that our AA can harvest and refill.
- **AA-driven loop.** A privileged agent borrows USDC/cbBTC via AAVE flash loans (1% of pool reserves), purchases discounted cbBTC/USDC on FAFE pools (which start at -50% price due to -5000 bps offsets), sells externally at full market price, repays AAVE loan + fees, deposits profits back to pools (5% to treasury, 95% to pool), and rebalances offsets automatically. This compounds TVL over time. 
- **Single-source of truth.** Deployment manifests, pool manifests, snapshots, scripts, and guides all live in this repo; there is no hidden state.
- **Permissioned surface.** `supplicate` is gated by `FAFEAccessManager`. Only whitelisted operators (e.g., `MASS_TESTER_ADDRESS`) can tap the subsidized pools.


---

## 2. Contract Architecture

| Component | Solidity File | Responsibility |
| --- | --- | --- |
| **FAFEAccessManager** | `contracts/FAFEAccessManager.sol` | Stores approved supplicators, exposes `setApprovedSupplicator` / `isApprovedSupplicator`. |
| **FAFETreasury** | `contracts/FAFETreasury.sol` | Owns factory/access/router, performs `bootstrapViaTreasury`, fee custody, and governance actions. |
| **FAFEFactory** | `contracts/FAFEFactory.sol` | Mints `FAFEPool` instances (ASSET/USDC), enforces treasury-only creation, tracks metadata. |
| **FAFEPool** | `contracts/FAFEPool.sol` | Holds reserves, applies ±5,000 bps multipliers via `_quoteAmount`, clamps payouts to inventory, exposes `supplicate`/`quote`. |
| **FAFERouter** | `contracts/FAFERouter.sol` | Entry point for `supplicate`, handles access control, aggregates events, and there is no per-hop accounting. Multi-hop MCV logic has been removed. `swap` now is also permissioned like supplicate and there is no per-hop accounting. We also need to create a `deposit` function that after the Autonomous Agent (AA) deposits what it borrowed after selling on the outside it deposits the profits into the pool it swapped from. |
| **FAFESupplicationQuoter** | `contracts/FAFESupplicationQuoter.sol` | Off-chain helper mirroring router math for bots/tests. |
| **IFAFE*** | `contracts/interfaces/` | Canonical interfaces for external integrations (access manager, factory, pool, router, treasury, quoter). |
| **Libraries** | `contracts/libraries/FullMath.sol`, `FixedPointMath.sol` | Deterministic mul/div helpers used by `_quoteAmount`. |
- **Create Dedicated AA Address/Key**
    This should be capable of being changed (only with through the Treasury Op) this is the (only) address that is permissioned to operate swap. This address can change at anytime if TreasuryOp sets it

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

An ASCII sketch of the base FAFE operation (offsets should flip for each pool after `swap`)

```
 USDC ----(−5k)----> [P1] || [P2] || [P3] (drain cbBTC)
   ^                                             |
   |                                             v
  AA loops <-----(+5k, sell cbBTC)----- [P4] ||[P5] || [P6]
```
```
 cbBTC ----(+5k)----> [P1] || [P2] || [P3] (drain USDC)
   ^                                             |
   |                                             v
  AA loops <-----(-5k, sell USDC)----- [P4] || [P5] || [P6]
```

Each `FAFEPool` applies its offset after each swap. Offsets remain fixed per pool.

---

## 4. AA Replenishment Loop & Treasury Ops

The AA processes pools sequentially in a continuous loop. For each pool, it executes steps 1-7, then after all 6 pools are processed once, it runs rebalancing (step 8), then repeats from pool 1.

**Per-Pool Cycle (Steps 1-7):**

1. **Borrow from Flash Loan Provider (AAVE).** Based on the pool's offset (negative or positive bps), AA borrows USDC (for negative-bps pools) or cbBTC (for positive-bps pools) via AAVE flash loans. The amount is 1% of the pool's reserves for that token. Flash loans allow borrowing without collateral, with fees (~0.09%) paid upon repayment.
2. **Swap on FAFE pool.** Use borrowed tokens to swap on the pool via authorized `swap` calls. Negative-bps pools (USDC → cbBTC) and positive-bps pools (cbBTC → USDC) both provide ~1.5× the base CFMM output due to ±5,000 bps offsets (pools start undervalued at -50% price).
3. **Buy externally at market price.** Use borrowed funds to buy cbBTC/USDC on external DEXs/aggregators at full market price (no discount).
4. **Sell externally at market price.** Sell the cbBTC/USDC obtained from FAFE swaps externally at full market price to realize profit (the difference between FAFE's -50% discount and external market price).
5. **Return borrowed amount + fees to AAVE.** Repay the flash loan principal plus AAVE's fees (~0.09%), keeping the profit.
6. **Deposit profit to pools.** Deposit remaining profit back to the pool through `FAFERouter.deposit()`, which sends 5% to treasury and 95% to the pool. This increases TVL.

**After All 6 Pools Processed:**

7. **Rebalance.** After completing one full cycle through all 6 pools, the AA scans all pools via `FAFEFactory.getPools()`, compares reserves using `FAFEPool.reserveAsset()` and `FAFEPool.reserveUsdc()`, and identifies pools where one has ≥5% more reserves than another. The AA then executes `FAFERouter.rebalance()` to move 2.5% of the excess from the imbalanced pool to the pool with less reserves. This ensures all pools maintain equal balances without requiring external asset purchases. See "Pool Scanner & Rebalancing Logic" in section 7 for implementation details.

**Repeat:** After rebalancing, the cycle starts again from pool 1. Because premiums are deterministic and available in both directions (cbBTC and USDC), cycling this loop continuously compounds treasury TVL while keeping external participants blinded to the subsidy.


---

## 5. Deployment & Testing Workflow

1. **Install deps & generate types**
   ```bash
   npx hardhat compile
   ```
2. **Run contract/test suites** (post-rename):
   ```bash
   npx hardhat test test/PoolMath.spec.ts
   npx hardhat test test/AccessGating.Supplicate.spec.ts
   npx hardhat test test/Deployment/*.spec.ts  # future FAFE suites
   ```
   - Test Swap/Supplications to see how "in down markets" if Supplications(CBBTCtoUSDC/USDCtoCBBTC) will provide same premiums to-and-from like swaps and log onto API-LPP/MASS Buildnotes.md in Arells 
3. **Build Dummy AA**
  - **Daily FAFE Operations.** Build a "DUMMY AA API that borrows from "TreasuryOps" meaning it takes USDC/CBBTC from TreasuryOps (TreasuryOps calls deposit)" The AA must execute a daily cycle through all six pools (one operation per pool). The system tracks:
    - **Pool operation tracking:** Log each swap operation with pool address, direction, amounts, and timestamp
    - **External sale tracking:** Log when AA sells borrowed assets externally (deposits amount back to TreasuryOps (which will be Flash Loan distributor))
    - **Borrow repayment:** Log when AA deposits the borrowed principal back to the pool it swapped from
    - **Profit deposit:** Log when AA deposits profits back to the same pool
    - **Daily completion:** Track when all 6 pool operations are complete and stop further operations until next day

4. **Deploy to Base mainnet** with verbose logging:
   ```bash
   LOG_FILE=logs/deploy-$(date +%Y%m%d-%H%M%S).log \
   npx hardhat run scripts/deploy.ts --network base 2>&1 | tee "$LOG_FILE"
   ```
   The script now:
   - Uses `FAFE*` contract names.
   - Emits timestamped steps (access deploy, treasury transfer, manifest write).
5. **Seed & test a FAFE pool:**
   ```bash
   FAFE_ASSET_AMOUNT=0.000012 \
   FAFE_USDC_AMOUNT=0.5 \
   FAFE_SUPPLICATE_USDC=0.5 \
   npx hardhat run scripts/fund-treasury.ts --network base

   npx hardhat run scripts/run-fafe-flow.ts --network base
   ```
   This builds a new −5,000 bps pool, approves `MASS_TESTER`, runs a 0.5 USDC `supplicate`, and writes `fafe-*-supplicate` snapshots under `test/Deployment/__snapshots__/`.
6. **Manifests & snapshots**
   - `deployment-manifest.json`: latest FAFE contract addresses.
   - `test/Deployment/pool-manifest.json`: known pools with offsets.
   - `test/Deployment/__snapshots__`: canonical pre/post states for CI assertions.
7. **Test Dummy AA On-chain**
   - activate Test Dummy so see how it'll interact, log events into snapshot?
       - **API integration:** All operations logged via API endpoint for monitoring and audit trail 
    Treasury automation scripts (`scripts/run-fafe-flow.ts`, forthcoming AA controllers) encapsulate these steps and emit JSON snapshots under `test/Deployment/__snapshots__` for auditing.
---

## 6. Monitoring & Next Steps

- **Runtime telemetry:**
  - `SwapExecuted`, `DepositExecuted`, `RebalanceExecuted`, and treasury donations for Grafana ingestion.
  - `scripts/read-onchain-prices.ts` remains the lightweight sanity check for reserve/price drift.
- **Daily FAFE Operations API (to be built inside AA directory [re-write README.md in AA Directory]):**
  - **TreasuryOp should Seed ETH/BASE to AA and approved Supplicators**
    - $0.05 cents for approved supplicators. if it gets less than $.01, seed up to $.05
    - $5 for AA (if it gets less than $1, seed up to $4)
  - **Borrowing & Flash Loan Integration (AAVE/Other Lenders):**
    - **AAVE API Integration:** Connect to AAVE V3 (or other flash loan providers) on Base network
    - **Borrowing Mechanism:**
      1. AA queries pool reserves via `FAFEPool.reserveUsdc()` and `FAFEPool.reserveAsset()`
      2. AA calculates 1% of pool's USDC/cbBTC reserves to borrow
      3. AA calls AAVE flash loan API to borrow the calculated amount
      4. AA receives borrowed tokens in a single transaction
    - **Flash Loan Flow:**
      - `POST /api/borrow/initiate` - Initiate flash loan from AAVE (amount, token, pool address)
      - `POST /api/borrow/execute` - Execute flash loan transaction (includes external buy/sell)
      - `POST /api/borrow/repay` - Repay borrowed amount + AAVE fees
      - `GET /api/borrow/status` - Check current borrow status and available liquidity
    - **AAVE Integration Details:**
      - Use AAVE V3 Pool contract on Base: `0x...` (to be configured)
      - Flash loan callback: `executeOperation()` must handle:
        - Receive borrowed tokens
        - Buy cbBTC/USDC externally at market price
        - Sell cbBTC/USDC externally at full market price → realize profit
        - Return borrowed amount + fees to AAVE
        - Deposit profit to FAFE pools via `FAFERouter.deposit()`
      - Fee calculation: AAVE charges ~0.09% flash loan fee (varies by market)
    - **External Market Integration:**
      - Connect to DEX aggregators (1inch, 0x, etc.) for best execution prices
      - `POST /api/markets/quote` - Get external market quotes for buy/sell
      - `POST /api/markets/execute` - Execute external market trades
      - Track profit margins: external price vs FAFE pool price (with -50% discount)
  - **Event listeners:** Monitor on-chain `SwapExecuted`, `DepositExecuted`, and `RebalanceExecuted` events from `FAFERouter`
  - **API endpoints:**
    - `POST /api/operations/swap` - Log swap operation (pool, direction, amounts, tx hash)
    - `POST /api/operations/borrow` - Log flash loan initiation (lender, amount, token, fees)
    - `POST /api/operations/external-buy` - Log external market purchase (venue, amount, price)
    - `POST /api/operations/external-sale` - Log external market sale (venue, amount, price, profit)
    - `POST /api/operations/repay` - Log borrow repayment (amount, fees paid)
    - `POST /api/operations/profit` - Log profit deposit back to pool
    - `GET /api/operations/daily-status` - Get current day's operation status (pools completed, remaining)
    - `GET /api/operations/history` - Query historical operations
  - **Daily cycle tracking:**
    - Track which of the 6 pools have been operated on today
    - Stop operations once all 6 pools are complete
    - Reset at midnight UTC for next day
  - **Integration:** Log to Arells monitoring stack (Notion/Kibana) and `Build-Notes.md`
   - **Pool Scanner & Rebalancing Logic (to be built):**
      - **Pool Discovery:** AA queries `FAFEFactory.getPools()` to get all pool addresses
      - **Reserve Scanning:** For each pool, AA calls `FAFEPool.reserveAsset()` and `FAFEPool.reserveUsdc()` to get current reserves
      - **Imbalance Detection Algorithm:**
         1. Group pools by token pair (ASSET/USDC)
         2. For each token type (ASSET or USDC), calculate the average reserve across all pools
         3. Identify pools where one pool has ≥5% more reserves than another pool
         4. Calculate rebalance amount: 2.5% of the imbalanced pool's excess reserve
         5. Execute rebalance via `FAFERouter.rebalance()` (AA-only permissioned)
      - **Script structure:** `scripts/scan-and-rebalance.ts`
         - Queries factory for all pools
         - Scans reserves for each pool
         - Identifies rebalancing opportunities
         - Executes rebalances when threshold is met
         - Logs all operations to API
      - **API endpoints:**
         - `GET /api/pools/scan` - Scan all pools and return reserve status
         - `GET /api/pools/rebalance-opportunities` - Get list of pools that need rebalancing
         - `POST /api/pools/rebalance` - Execute rebalance operation (logs to operations API)
- **AA + treasury dashboards (2-3 days):** integrate logs from `run-fafe-flow` and future AA controllers into Arells' monitoring stack (Notion/Kibana) to track TVL, premium capture, and refill cadence, test with 6 FAFE operations per day (1 per pool) and calculate new FAFE operations.

## 7. Tightening Security and Main Re-deployment
- **Security & scale:**
  - Expand spec coverage (reentrancy, pause paths).
  - Prepare for 6→N pool scaling by parameterizing `FAFEFactory` and `FAFETreasury` with offset templates.
  - Document upgrade FAFE and incident response and add lots of security parameters (test all edge cases (since its permissioned, no one can transfer, swap, supplicate or deposit unless the treasury allows them, ensure treasury cannot burn any deposits set by liquidity etc, rebalancing hack/exploit from AA etc)) 
      - Test all these security tests after deployment.
- **Prepare for main re-deployment** 
   - Create new TreasuryOperator|AA/Address/Key save it outside .env
   - Remove "yous"
   - Set new daily FAFE operations.
   - Bootstrap new pools

## 8. Re-write HPM(codebase)/MASS(codebase)/LPP(codebase)/FAFE Readmes

- Rewrite all returns in bull/bear markets (including graphs) to fit FAFE dynamics.

With FAFE, every piece of code, documentation, and operational workflow exists to support the autonomous premium-harvesting loop (LPP). Keep the manifests current, enforce access controls, and the system remains a self-funding liquidity engine.
