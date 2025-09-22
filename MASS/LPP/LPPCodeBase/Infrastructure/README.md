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
- [ ] **Wire 1% profit‑share via JS** (off‑chain orchestrator; no on‑chain logic changes)
- [ ] Frontend/API: router prefers **A/B/C (0‑fee)**, metrics & drift badge
- [ ] Tests: zero‑fee math, range flips, oracle failure, MEV re‑center sim, **rebate logic**
- [ ] Deploy to Base, verify, publish docs, and announce to searchers

---

## 1. Repos & Licensing

- Fork **core** (Factory, PoolDeployer, Pool) and **periphery** (NonfungiblePositionManager, Router).  
- Keep GPL/NOTICE headers intact.  
- Publish periphery as **`@hpm/lpp-periphery`** (router helpers, mint helpers, utilities).  
- Pin toolchain (Foundry/Hardhat); add CI.

---

## 2. Zero‑Fee Tier (Factory & Math)

- Expose owner‑gated `enableFeeAmount(uint24 fee, int24 tickSpacing)` and call with **`fee = 0`**, **tickSpacing = 10** (example).  
- Audit Pool/SwapMath: **fee=0** must result in **no fee accrual** and **no div‑by‑zero**.  
- Tests: swap through a 0‑fee pool and assert `feeGrowthGlobal{0,1}X128 == 0` and protocol fee paths are inert.

---

## 3. Governance & Safety

- Owner of Factory/params = **Safe** (2–3 signers).  
- **Protocol swap fee disabled** (LP fee is 0 ⇒ protocol slice must be 0).  
- Optional **LPPRouter** (front‑door) with **pause** flag (core pools stay permissionless).

---

## 4. Oracle Adapter (USD → raw token amounts)

**`LPPOracleAdapter`**:  
- Source **BTC/USD** (e.g., Chainlink).  
- Guardrails: **staleness** (`now - updatedAt <= maxAge`) & **max deviation** vs last good price.  
- Helpers (cbBTC **8d**, USDC **6d**):
```
usdcRaw(USD)  = USD * 10^6
cbBtcRaw(USD) = floor((USD * 10^8) / P)   // P = BTC price in USD, scaled to 1e8
```

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

**Goal:** always quote and create small profitable drifts for external MEV.

- **Pool A (anchor):** USDC = **$100**, cbBTC ≈ **$100** (≈ 0.001 cbBTC)\*  
- **Pool B (mid):**    USDC = **$50**,  cbBTC ≈ **$50**  (≈ 0.0005 cbBTC)\*  
- **Pool C (thin):**   USDC = **$25**,  cbBTC ≈ **$25**  (≈ 0.00025 cbBTC)\*

\* cbBTC units come from **LPPOracleAdapter** at mint time.

For each pool:  
- **Primary position:** ultra‑narrow (≈ ±1–2 ticks) around oracle tick.  
- **Fallback position:** tiny, very wide range to prevent “no‑liquidity”.  
- Mint via **NonfungiblePositionManager** (wrapped in **`@hpm/lpp-periphery`** helpers).  
- *(Optional)* centers at −5 bps / 0 / +5 bps for (A/B/C) to allow internal A↔C arbs.

---

## 7. External MEV Re‑Centering (no swap bounties)

- Choose drift threshold `ε` (e.g., **20–30 bps**) vs oracle.  
- If `|drift| > ε`, searchers arb: buy cheap from 0‑fee pools and sell on fee’d venues (or A↔C internally).  
- **Fallback range** guarantees quotability for instant execution.

---

## 8. Discovery & Solver Adoption

- Verify contracts on **BaseScan** (ABIs/decimals discoverable).  
- **Subgraph**: pools, slot0, liquidity, TWAP, drift vs oracle.  
- Emit **`RebalanceNeeded(int256 driftBps)`** on threshold breach.  
- **Solver Kit** (TS + Foundry): `getPoolStates()`, `getOraclePrice()`, `computeDriftAndSize()`, and private‑bundle templates.

---

## 9. MEV‑as‑LP Incentives (rebates **in‑kind**, with **LPP retention**)
*(On‑chain, immutable parameters once deployed — tiers can be encoded in the hook or governed by immutable constants.)*

### 9.1 Contracts
- **`LPPRebateVault`** (USDC vault + cbBTC vault) — holds reserves; pays rebates **in‑kind**; emits `RebatePaid`.
- **`LPPMintHook`** — wraps NPM; computes **eligible tier**; **skims** `(rebate + retention)` **off‑pool**; calls vault & treasury.
- **`LPPTreasury`** — receives retention; may route a portion to **POL** for A/B/C.

### 9.2 Eligibility
Qualify if any:
- Mint during **Rebalance Window** (N blocks after `RebalanceNeeded`).  
- Mint adds **≥ X% of current pool TVL**.  
- Position centered within **δ ticks** of oracle at mint.

### 9.3 Tiered **Deposit‑Share → Rebate** (example schedule)
Let `S = minted notional / pool TVL` (USD via adapter).

| Tier | S (share of TVL) | **LP Rebate** | **LPP Retention** |
|------|------------------:|:-------------:|:-----------------:|
| T1   |  5% – <10%        | **1.0%**      | **0.5%**          |
| T2   | 10% – <20%        | **2.0%**      | **1.0%**          |
| T3   | 20% – <35%        | **3.5%**      | **1.5%**          |
| T4   | 35% – <50%        | **5.0%**      | **2.0%**          |
| T5   | ≥50% (capped)     | **6.0%**      | **2.5%**          |

- **Denomination:** payouts follow the same asset mix supplied (USDC/cbBTC).  
- **Caps & Vesting:** per‑mint & per‑epoch caps; 1–24h vest; early exit slash.  
- **Funding:** mint surcharge (off‑pool), optional epoch top‑ups, optional growth drip when weekly TVL ↑ ≥5%.

---

## 10. **1% Profit‑Share — Off‑Chain JS Orchestrator (Mutable)**

> Profit‑share logic **not** hard‑coded in smart contracts. It runs as a **.js** service that computes 1% of users’ realized profits and sends rewards to MEV participants. Parameters (weights, cadence, caps) are **mutable** via config.

### 10.1 Responsibilities (JS)
- **Ingest P&L:** read users’ realized profits (router/accounting helpers, subgraph, or indexed events).  
- **Allocate 1%** of realized profits into a **MEV rewards pot** (USDC/cbBTC split by realized side).  
- **Score actors**: recent re‑center trades, LP hold time, and volume (from Subgraph).  
- **Payout**: initiate USDC/cbBTC transfers from **LPPTreasury** or a signer wallet to MEV addresses.  
- **Logs**: write a Merkle snapshot (address → amounts) to IPFS or a repo for auditability.

### 10.2 Config (example)
```json
{
  "epochSeconds": 86400,
  "pnlShareBps": 100,                // 1% of realized profits
  "minPayout": { "USDC": 25e6, "cbBTC": 1000 }, // dust thresholds (raw)
  "weights": { "lpHold": 0.4, "recenter": 0.4, "volume": 0.2 },
  "caps": { "perEpochUsd": 25000, "perAddrUsd": 2500 }
}
```

### 10.3 Minimal On‑Chain Touchpoints
- **`LPPTreasury`** or **`ProfitShareEscrow`** contract that simply **holds funds** and exposes `transfer(address token, address to, uint256 amount)` — *no logic inside*.  
- JS runner holds keys (or uses a Safe) to authorize transfers per epoch snapshot.

---

## 11. Routing & UI

- **LPPRouter** prefers A/B/C 0‑fee pools; cascades to public pools if order size exceeds tight ranges.  
- `/quote` shows best path & **drift badge**.  
- UI: composition gauges, drift pill, **MEV‑as‑LP** panel (tiers, vault liquidity), and **Profit‑Share** epoch stats.

---

## 12. Tests (must pass before mainnet)

- **Zero‑fee math** invariant.  
- **Range behavior** (primary one‑sided; fallback still quotes).  
- **Oracle guards** (stale/invalid → HOLD).  
- **MEV sim**: external move + backrun → pools re‑center within `ε`.  
- **Rebate tests**: tiers, vesting, slashing, caps, multi‑asset splits.  
- **Economic sim**: volume vs vault depletion; dilution under many small mints.  
- **Off‑chain harness**: deterministic JS allocation against a fixed event log; Merkle snapshot reproducibility.

---

## 13. Deployment Plan (Base)

1. Deploy **Factory/Core**, `enableFeeAmount(0, tickSpacing=10)`.  
2. Deploy **`@hpm/lpp-periphery`** (router + mint helpers).  
3. Deploy **LPPOracleAdapter**; wire feed & guards.  
4. Deploy **LPPRebateVault**, **LPPMintHook**, **LPPTreasury**; set roles.  
5. **Create** Pools A/B/C; **initialize** at oracle price.  
6. **Seed** primary + fallback positions (adapter‑computed amounts).  
7. Verify, publish **Subgraph** & **Solver Kit**; announce to searchers.  
8. Stand up the **JS Profit‑Share** service; point it at Safe/Treasury.

---

## 14. Amounts & Math 

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

## 15. Minimal Interfaces (optional)

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
```
