# LPPv1 Infrastructure — Blueprint

## Progress Checklist

- [X] Dismantle and rebuild [Protocol](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Protocol) & [Preriphery](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Periphery): **Complete**
- [ ] Configure and compile [Protocol](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Protocol) & [Preriphery](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Periphery): ***In-Progress***
- [ ] Enable **fee = 0** tier in Factory; add **fee=0 math tests**
- [ ] Set governance (**Safe multisig**); protocol swap fee **disabled**
- [ ] Implement **LPPOracleAdapter** (BTC/USD with staleness & deviation guards)
- [ ] **Create 3 pools** (cbBTC/USDC, fee=0) & **initialize** at oracle price
- [ ] **Seed liquidity**: tight **primary** range + tiny **fallback** range for each pool
- [ ] Make arbs find LPP pools: contract **verification**, **Subgraph**, `RebalanceNeeded` event, **Solver Kit**
- [ ] Implement **MEV‑as‑LP incentives** (rebates in deposited asset; **LPP retention**)
- [ ] Implement **1% profit‑share** to MEV from **user realized profits**
- [ ] Frontend/API: router prefers **A/B/C (0‑fee)**, metrics & drift badge
- [ ] Tests: zero‑fee math, range flips, oracle failure, MEV recentre sim, **rebate & profit‑share logic**
- [ ] Deploy to Base, verify, publish docs, and announce to searchers

---

## 1. Repos & Licensing

- Fork **core** (Factory, PoolDeployer, Pool) and **periphery** (NonfungiblePositionManager, Router).
- Keep GPL/NOTICE headers intact.
- Publish periphery as **`@hpm/lpp-periphery`** (router helpers, mint helpers, utilities).
- Pin toolchain versions (Foundry/Hardhat); add CI.

---

## 2. Zero‑Fee Tier (Factory & Math)

- Expose owner‑gated `enableFeeAmount(uint24 fee, int24 tickSpacing)` and call with **`fee = 0`** and **tickSpacing = 10** (example).
- Audit Pool/SwapMath: **fee=0** must yield **no fee accrual** and **no div‑by‑zero**.
- Tests: swap through a 0‑fee pool and assert `feeGrowthGlobal{0,1}X128 == 0` and protocol fee paths are inert.

---

## 3. Governance & Safety

- Factory/params owner = **Safe** (2–3 signers).
- **Protocol swap fee disabled** (LP fee is 0 ⇒ protocol slice must be 0).
- Optional **LPPRouter** (front‑door) with **pause** flag (core pools remain permissionless).

---

## 4. Oracle Adapter (USD → raw token amounts)

**`LPPOracleAdapter`**:
- Source: **BTC/USD** (e.g., Chainlink).
- Guardrails: **staleness** (`now - updatedAt <= maxAge`) & **max deviation** vs last good price.
- Helpers (cbBTC **8d**, USDC **6d**):
  ```
  usdcRaw(USD)  = USD * 10^6
  cbBtcRaw(USD) = floor((USD * 10^8) / P)   // P = BTC price in USD, scaled to 1e8
  ```
- Normalizes USDC/cbBTC amounts for mints and reporting.

---

## 5. Create & Initialize the Three Pools (fee=0)

- Token order: `token0 = cbBTC (8d)`, `token1 = USDC (6d)`.
- `factory.createPool(token0, token1, 0)`, then:
  ```
  price = USDC per 1 cbBTC (scaled)
  sqrtPriceX96 = encodeSqrtRatioX96(price * 10^(dec1 - dec0))
  pool.initialize(sqrtPriceX96)
  ```

---

## 6. Seed Liquidity (primary + fallback)

Goal: **always quote** and create small profitable drifts for external MEV.

- **Pool A (anchor):** USDC = **$100**, cbBTC ≈ **$100** (≈ 0.001 cbBTC)*
- **Pool B (mid):**    USDC = **$50**,  cbBTC ≈ **$50**  (≈ 0.0005 cbBTC)*
- **Pool C (thin):**   USDC = **$25**,  cbBTC ≈ **$25**  (≈ 0.00025 cbBTC)*

\* cbBTC units computed via **LPPOracleAdapter** at mint time.

For each pool:
- **Primary position:** ultra‑narrow (≈ ±1–2 ticks) around oracle tick.
- **Fallback position:** tiny, very wide range to prevent “no‑liquidity”.
- Mint via **NonfungiblePositionManager** (wrapped in **`@hpm/lpp-periphery`** helpers).
- *(Optional)* centers at −5 bps / 0 / +5 bps for (A/B/C) to allow internal A↔C arbs.

---

## 7. External MEV Re‑Centering (no swap bounties)

- Pick drift threshold `ε` (e.g., **20–30 bps**) vs oracle.
- If `|drift| > ε`, searchers arb: buy cheap from 0‑fee pool(s) and sell on fee’d venues (or A↔C internally).
- **Fallback range** guarantees quotability for instant execution.

---

## 8. Discovery & Solver Adoption

- Verify contracts on BaseScan (ABIs/decimals discoverable).
- Subgraph: pools, slot0, liquidity, TWAP, **drift vs oracle**.
- Event: **`RebalanceNeeded(int256 driftBps)`** on threshold breach.
- **Solver Kit** (TS + Foundry):
  - `getPoolStates()`, `getOraclePrice()`
  - `computeDriftAndSize()` sizing
  - Private‑bundle templates (OP‑stack / Protect‑style endpoints).

---

## 9. MEV‑as‑LP Incentives (rebates **in‑kind**, with **LPP retention**)

> MEVs can LP and receive **rebates in the asset mix they deposit** (USDC/cbBTC). LPP retains a slice of every payout to fund ops and POL.

### 9.1 Contracts

- **`LPPRebateVault`** (USDC vault + cbBTC vault)
  - Holds rebate reserves (funded by **mint surcharge** and scheduled top‑ups).
  - Pays rebates **in‑kind** to qualifying LP mints.
  - Emits `RebatePaid(lp, pool, asset, amount, tier, tvlBefore, tvlAfter)`.

- **`LPPMintHook`** (wrapper around NPM)
  - Computes **eligible rebate tier** on mint.
  - **Skims** `(rebate + retention)` **off‑pool** from the submitter before adding remaining liquidity.
  - Instructs `LPPRebateVault` to pay LP and `LPPTreasury` to collect retention.

- **`LPPTreasury`**
  - Receives **retention** and can route a fraction to **POL** (Protocol‑Owned Liquidity) in A/B/C.

### 9.2 Eligibility

Qualify if **any** holds:
- Mint during a **Rebalance Window** (N blocks after `RebalanceNeeded`).
- Mint adds **≥ X% of current pool TVL**.
- Position center within **δ ticks** of oracle at mint.

### 9.3 Tiered **Deposit‑Share → Rebate** (examples)

Let `S = minted notional / pool TVL at mint` (USD via adapter).

| Tier | S (share of TVL) | **LP Rebate** (same-asset split) | **LPP Retention** (same-asset split) |
|------|------------------:|:---------------------------------:|:------------------------------------:|
| T1   |  5% – <10%        | **1.0%**                          | **0.5%**                              |
| T2   | 10% – <20%        | **2.0%**                          | **1.0%**                              |
| T3   | 20% – <35%        | **3.5%**                          | **1.5%**                              |
| T4   | 35% – <50%        | **5.0%**                          | **2.0%**                              |
| T5   | ≥50% (capped)     | **6.0%**                          | **2.5%**                              |

- **Denomination:** if LP supplies 60% USDC / 40% cbBTC, payouts follow **60/40** in‑kind split.
- **Caps:** per‑mint & per‑epoch caps; vesting 1–24h; early exit slash.

### 9.4 Funding (no swap fees)

- **Mint Surcharge (off‑pool):** for qualifying mints, route `(rebate + retention)` from submitted tokens; the **remainder** is deposited as liquidity.
- **Epoch Top‑Ups:** LPP treasury / partners top‑up vaults.
- **TVL Growth Drip (optional):** if weekly TVL ↑ **≥5%**, emit a small drip prorated to recent MEV‑LPs.

---

## 10. 1% Profit‑Share to MEV

- Track **user realized profits** (net of deposits) via router/accounting helper.
- **`LPPProfitShareDistributor`** streams **1% of realized profits** to a MEV rewards pot (USDC/cbBTC split by realized side).
- Distribute periodically to recent MEV actors (LP addresses + addresses seen balancing pools) using a score: `score = volume_weight + recenter_events + LP_hold_time`.

---

## 11. Routing & UI

- **LPPRouter** prefers A/B/C 0‑fee pools; cascades to public pools if order > tight range.
- `/quote` shows best path and **drift badge**.
- UI: gauges, drift pill, **MEV‑as‑LP** panel with **tier status & vault liquidity**.

---

## 12. Tests (must pass before mainnet)

- **Zero‑fee math** invariant.
- **Range behavior** (primary → one‑sided; fallback quotes).
- **Oracle guards** (stale/invalid → HOLD).
- **MEV sim**: external move + backrun → pools re‑center within `ε`.
- **Rebate tests**: tiers, vesting, slashing, caps, multi‑asset splits.
- **Profit‑share tests**: realized P&L detection, 1% extraction, distributor fairness.
- **Economic sim**: volume vs vault depletion; dilution under many small mints.

---

## 13. Deployment Plan (Base)

1. Deploy **Factory/Core**, `enableFeeAmount(0, tickSpacing=10)`.
2. Deploy **`@hpm/lpp-periphery`** (router + mint helpers).
3. Deploy **LPPOracleAdapter**; wire feed + guards.
4. Deploy **LPPRebateVault**, **LPPMintHook**, **LPPTreasury**, **LPPProfitShareDistributor**; set roles.
5. **Create** Pools A/B/C; **initialize** at oracle price.
6. **Seed** primary + fallback positions (adapter‑computed amounts).
7. Verify, publish **Subgraph** & **Solver Kit**; announce to searchers.

---

## 14. Amounts & Math (copy‑paste)

```
DECIMALS:
  cbBTC = 8
  USDC  = 6

Given BTC/USD price P (scaled to 1e8):

usdcRaw(USD)  = USD * 10^6
cbBtcRaw(USD) = floor((USD * 10^8) / P)

Seed targets:
  Pool A: USDC = usdcRaw(100), cbBTC = cbBtcRaw(100)    // ≈ 0.001 cbBTC (example)
  Pool B: USDC = usdcRaw(50),  cbBTC = cbBtcRaw(50)     // ≈ 0.0005 cbBTC
  Pool C: USDC = usdcRaw(25),  cbBTC = cbBtcRaw(25)     // ≈ 0.00025 cbBTC

Initialize (token0 = cbBTC, token1 = USDC):
  sqrtPriceX96 = encodeSqrtRatioX96(price * 10^(dec1 - dec0))
```

---

## 15. Minimal Helper Interfaces (optional)

```solidity
interface ILPPOracleAdapter {
  function priceUsdPerBtc() external view returns (uint256 price1e8, uint256 updatedAt);
}

interface ILPPRebateVault {
  function availableUSDC() external view returns (uint256);
  function availableCBBTC() external view returns (uint256);
  function payRebate(address to, address token, uint256 amount) external;
  event RebatePaid(address indexed to, address indexed pool, address indexed token, uint256 amount, uint8 tier);
}

interface ILPPMintHook {
  struct MintParams {
    address pool;
    int24 tickLower;
    int24 tickUpper;
    uint256 amount0Desired; // cbBTC
    uint256 amount1Desired; // USDC
    address recipient;
  }
  function mintWithRebate(MintParams calldata) external returns (uint256 tokenId, uint8 tierApplied);
  event Qualified(address indexed lp, address indexed pool, uint8 tier, uint256 shareBps);
}

interface ILPPProfitShareDistributor {
  function registerProfit(int256 pnlUSDC, int256 pnlCBBTC) external;
  function distribute() external;
  event ProfitRouted(uint256 usdc, uint256 cbBtc);
  event Distributed(address indexed to, uint256 usdc, uint256 cbBtc);
}
```