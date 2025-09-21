# LPPv1 Infrastructure — Blueprint

## Progress Checklist

- [X] Dismantle and rebuild [Protocol](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Protocol) & [Preriphery](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Periphery): **Complete**
- [ ] Configure and compile [Protocol](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Protocol) & [Preriphery](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Periphery): ***In-Progress***
- [ ] Enable **fee = 0** tier in Factory; add tests for fee=0 math
- [ ] Set governance (Safe multisig); protocol fee disabled  
- [ ] Implement **LPPOracleAdapter** (BTC/USD, staleness & deviation checks)  
- [ ] **Create 3 pools** (cbBTC/USDC, fee=0) and **initialize** at oracle price  
- [ ] **Seed** each pool: tight **primary** range + tiny **fallback** wide range  
- [ ] Make arbs find you: **verify contracts**, **Subgraph**, **RebalanceNeeded** event, **Solver Kit**  
- [ ] Frontend & API: router prefers **A/B/C** 0-fee, then falls back to public pools  
- [ ] Tests: zero-fee math, range flips, oracle failure, MEV recenter sim  
- [ ] Deploy to Base, verify, publish docs, announce to searchers

---

## Step-by-Step Guide

### 1. Repos & Licensing
- Fork **core** (Factory, PoolDeployer, Pool) and **periphery** (NonfungiblePositionManager, Router).  
- Keep GPL license headers/NOTICE intact.  
- Rename/publish periphery as **`@hpm/lpp-periphery`** (router helpers, mint helpers, utilities).  
- Pin toolchain (Foundry/Hardhat), add CI.

---

### 2. Zero-Fee Tier (Factory & Math)
- In Factory, expose owner-gated `enableFeeAmount(uint24 fee, int24 tickSpacing)` and call it with **`fee = 0`** and a **tickSpacing** (e.g., `10`).  
- Audit fee math paths in Pool/SwapMath so **fee=0** yields **no fee accrual** and no div-by-zero.  
- Add unit tests: swap through a 0-fee pool and assert `feeGrowthGlobal{0,1}X128` stays unchanged.

---

### 3. Governance & Safety
- Owner of Factory/params = **Safe** (2–3 signers).  
- **Protocol fee disabled** (LP fee is 0, so protocol fee slice must be 0).  
- Optional **LPPRouter** (front-door) with a **pause** flag (core pools remain permissionless).

---

### 4. Oracle Adapter (USD → raw token amounts)
Implement **`LPPOracleAdapter`**:
- Reads **BTC/USD** (e.g., Chainlink).  
- Enforce **staleness** (e.g., `now - updatedAt <= maxAge`) and **max deviation** vs last price.  
- Provide helpers to convert USD budgets into token raw amounts (cbBTC has **8 decimals**, USDC **6 decimals**):

```
usdcRaw(USD)  = USD * 10^6
cbBtcRaw(USD) = floor((USD * 10^8) / P)   // P = BTC price in USD, scaled to 1e8 (normalize to your feed)
```

---

### 5. Create & Initialize the Three Pools (fee=0)
- **Token order:** `token0 = cbBTC` (8d), `token1 = USDC` (6d) for consistent price math.  
- **Create:** `factory.createPool(token0, token1, 0)`.  
- **Initialize** at oracle price:
  - `price = USDC per 1 cbBTC` (scaled appropriately)  
  - `sqrtPriceX96 = encodeSqrtRatioX96(price * 10^(dec1 - dec0))`  
  - `pool.initialize(sqrtPriceX96)`

---

### 6. Seed Liquidity (primary + fallback)
Goal: **always quote** and create small, profitable drifts for external MEV.

- **Pool 1:** seed with `USDC = $150`, `cbBTC ≈ $50` (use adapter to compute raw amounts)  
- **Pool 2:** seed with `USDC = $10`,  `cbBTC ≈ $190`  
- **Pool 3:** seed with `USDC = $190`, `cbBTC ≈ $10`  

For **each** pool:
- **Primary position:** ultra-narrow range (≈ ±1–2 ticks) around current tick.  
- **Fallback position:** tiny, very wide range to prevent “no-liquidity” states.  
- Mint via **NonfungiblePositionManager** (wrapped in **`@hpm/lpp-periphery`** helpers).

*(Optional)* Micro-offset centers: A at oracle −5 bps, B at oracle, C at oracle +5 bps (creates a tiny internal A↔C spread).

---

### 7. External MEV Re-Centering (no bounties)
- Pick a **drift threshold** `ε` (e.g., **20–30 bps**) vs oracle.  
- When any pool deviates by > ε, searchers can **arb**: buy cheap from your 0-fee pool(s) and sell on fee’d venues (or A↔C internally).  
- Your **fallback** range keeps pools quotable so arbs can act immediately.  
- You pay **nothing**; the spread covers their gas and fees elsewhere.

---

### 8. Discovery & Solver Adoption (how arbs find you)
- **Verify** Factory, Pools, Router, Adapter on **BaseScan** so indexers pull ABIs/decimals.  
- Publish a **Subgraph** (pools, slot0, liquidity, twap, **drift vs oracle**).  
- Emit **`RebalanceNeeded(int256 driftBps)`** when `|drift| > ε` so bots can subscribe.  
- Publish a **Solver Kit** repo with:
  - `getPoolStates()` and `getOraclePrice()` examples  
  - `computeDriftAndSize()` to size the trade  
  - Private-bundle templates for OP-stack builders / Protect-style endpoints

---

### 9. Routing & UI
- **LPPRouter** prefers **A/B/C** (0-fee) and cascades to public pools if size exceeds your tight ranges.  
- `/quote` API exposes best path and a **drift badge**.  
- UI shows pool composition gauges and “oracle drift” pill (green within ε, amber beyond).

---

### 10. Tests (must pass before mainnet)
- **Zero-fee math:** no fee growth after swaps.  
- **Range behavior:** when primary goes one-sided, fallback still quotes.  
- **Oracle guards:** stale/invalid → router can degrade to HOLD (optional).  
- **Adversarial:** price gaps, empty side, extreme slippage, reorgs.  
- **MEV sim:** external price-moving swap + backrun → pools return within ε.

---

### 11. Deployment Plan (Base)
1. Deploy **Factory/Core**; **enable fee=0** with chosen `tickSpacing` (e.g., 10).  
2. Deploy **`@hpm/lpp-periphery`** (router + position helpers).  
3. Deploy **OracleAdapter**; wire feed address & guards.  
4. **Create** Pools A/B/C; **initialize** at oracle price.  
5. **Seed** primary + fallback positions using adapter-computed amounts.  
6. **Verify** contracts; publish **Subgraph** & **Solver Kit**; announce to searchers.

---

### 12. Amounts & Math (copy/paste)

```
DECIMALS:
  cbBTC = 8
  USDC  = 6

Given BTC/USD price P (scaled to 1e8):

usdcRaw(USD)  = USD * 10^6
cbBtcRaw(USD) = floor((USD * 10^8) / P)

Seed targets:
  Pool 1: USDC = usdcRaw(150), cbBTC = cbBtcRaw(50)
  Pool 2: USDC = usdcRaw(10),  cbBTC = cbBtcRaw(190)
  Pool 3: USDC = usdcRaw(190), cbBTC = cbBtcRaw(10)

Initialize price (token0 = cbBTC, token1 = USDC):
  sqrtPriceX96 = encodeSqrtRatioX96(price * 10^(dec1 - dec0))
```

---

### 13. Minimal Helper Interfaces (optional)

```solidity
interface ILPPOracleAdapter {
  function priceUsdPerBtc() external view returns (uint256 price1e8, uint256 updatedAt);
}

interface ILPPRebalanceHelper {
  struct PoolState { int24 tick; uint160 sqrtPriceX96; uint128 liquidity; }
  function getPoolStates() external view returns (PoolState[3] memory);
  function getOraclePrice1e8() external view returns (uint256);
  function driftBps() external view returns (int256[3] memory);
  event RebalanceNeeded(int256 driftBps, uint256 timestamp);
}
```

---

### 14. Notes & Caveats
- **LP fee = 0 ⇒ protocol fee = 0**. This is an **execution-rail** design; external MEV keeps you centered by harvesting spread elsewhere.  
- **Oracle dependency:** enforce staleness & deviation caps; consider HOLD mode if unhealthy.  
- **Discoverability is everything:** verified contracts, Subgraph, event signal, Solver Kit.

---

