<img src="https://github.com/Art-Sells/HPM/blob/main/MASS/LPP/LPPCodeBase/FAFE/FAFE-Logo.png" width="500px"> 

# FAFE: Fully Autonomous Financial Ecosystem — Blueprint

> Delivers a self-funding, permissioned liquidity plane where fixed premiums/discounts, AA arbitrage loops, and a six-pool lattice guarantee deterministic profitability and compounding TVL.

---

## 1. Scope

- **Deterministic premiums/discounts.** Every swap enforces a ±5,000 bps offset, yielding exactly 1.5× (premium) or 0.5× (discount) of the base CFMM quote with output clamped to available reserves. The AA continuously refills pools through the arbitrage loop, ensuring premiums remain available.
- **Six-pool lattice.** Three negative-offset pools (−5,000 bps) and three positive-offset pools (+5,000 bps) provide a fixed ladder of subsidized trades that our AA can harvest and refill.
- **AA-driven loop.** The MCV (formerly MEV) agent iterates across **every major DEX** plus internal FAFE metrics, computes the largest borrow it can take (flash loans via AAVE/TreasuryOps), routes that size into the venue with the best net return (after fees), repays the loan, then pushes **only the realized profit** back into FAFE via `deposit` (5% treasury / 95% pool). After all six pools complete their pass, the AA triggers `rebalance` so reserves stay within ±5%. There are **no router swaps anymore**—all premiums are captured off-platform and recycled through deposits. 
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
| **FAFERouter** | `contracts/FAFERouter.sol` | Entry point for `supplicate`, AA-only `deposit`, and AA-only `rebalance`. There is no longer any router `swap` surface; MCV captures edge externally and only returns profit via `deposit`. |
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

An ASCII sketch of the base FAFE operation (offsets flip after each `supplicate`)



Each `FAFEPool` applies its offset after every `supplicate`. Offsets remain fixed per pool.

---

## 4. AA Replenishment Loop & Treasury Ops

The AA processes pools sequentially in a continuous loop. For each pool, it executes steps 1-7, then after all 6 pools are processed once, it runs rebalancing (step 8), then repeats from pool 1.

**Per-Pool Cycle (Steps 1-6):**

1. **Borrow 1% via Flash Loan (AAVE/TreasuryOps).** For negative pools the AA borrows USDC, for positive pools it borrows cbBTC. Borrow size = 1% of the live reserve to keep impact minimal.
2. **Scan every DEX + RFQ endpoint.** The MCV service hits all allow‑listed DEX APIs (Uniswap, Aerodrome, BaseSwap, on-chain RFQs, etc.) plus its own fairness oracle, comparing output for the borrowed size (minus every venue's fee schedule).
3. **Execute the best external leg.** The borrowed tokens are routed to the venue with the highest net return. Because FAFE pools are hard-coded at ±5,000 bps, the AA knows the minimum premium it can capture relative to fair price, so it only executes trades that net at least a 50% edge after gas + venue fees. **No router `swap` is called anymore.**
4. **Repay flash lender.** The AA immediately returns principal + AAVE fee (~0.09%) from the external fills.
5. **Deposit profit back into the originating pool.** Whatever remains after repayment is treated as profit. The AA approves the router, calls `deposit`, and the router sends 5% to treasury, 95% to the targeted pool. This is the only on-chain action that touches FAFE reserves.
6. **Log + throttle.** Metrics are emitted to the AA API (pool id, borrow size, DEX chosen, realized profit, tx-hash) and the loop advances to the next pool.

**After All 6 Pools Processed:**

7. **Rebalance.** Once every pool has received a profit deposit, the AA scans `FAFEFactory.getPools()` and runs `FAFERouter.rebalance()` wherever one side carries ≥5% more USDC or ASSET than another. The router automatically withdraws 2.5% of the surplus and pushes it into the underweight pool, so no external inventory is required. See "Pool Scanner & Rebalancing Logic" in section 7 for implementation details.

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
   - Test `supplicate` flows only—router `swap` has been removed. Capture premium math from `SupplicateSwapApproved.spec.ts` and log into MASS build notes.
3. **Build Dummy AA**
  - **Daily FAFE Operations.** Build a "DUMMY AA API" that pulls flash loans from TreasuryOps/AAVE, runs external venue scans, and only deposits profit back into FAFE. The AA must execute a daily cycle through all six pools (one operation per pool). The system tracks:
    - **Pool operation tracking:** Log each borrow + chosen DEX route (pool id, token, venue, realized APR)
    - **External sale tracking:** Log when AA sells borrowed assets externally and when the flash loan principal is repaid
    - **Profit deposit:** Log each `deposit` call (pool id, token, amount, tx-hash, treasury cut)
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
  - `SupplicateExecuted`, `DepositExecuted`, `RebalanceExecuted`, and treasury donation events for Grafana ingestion.
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
  - **Event listeners:** Monitor on-chain `SupplicateExecuted`, `DepositExecuted`, and `RebalanceExecuted` events from `FAFERouter`
  - **API endpoints:**
    - `POST /api/operations/borrow` - Log flash loan initiation (lender, amount, token, fees)
    - `POST /api/operations/borrow` - Log flash loan initiation (lender, amount, token, fees)
    - `POST /api/operations/dex-route` - Log the winning DEX/routing decision (venue, quote, expected slippage)
    - `POST /api/operations/external-sale` - Log external market sale (venue, amount, price, profit)
    - `POST /api/operations/repay` - Log borrow repayment (amount, fees paid)
    - `POST /api/operations/profit` - Log profit deposit back to pool (pool id, token, amount, tx hash)
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
