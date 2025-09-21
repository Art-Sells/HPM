# LPPv1 Infrastructure — Blueprint

## Progress Checklist

- [X] Dismantle and rebuild [Protocol](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Protocol) & [Preriphery](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Periphery): **Complete**
- [ ] Configure and compile [Protocol](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Protocol) & [Preriphery](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Periphery): ***In-Progress***
- [ ] Enable **fee = 0** tier in Factory; add **fee=0 math tests**  
- [ ] Set governance (**Safe multisig**); protocol swap fee **disabled**  
- [ ] Implement **LPPOracleAdapter** (BTC/USD with staleness & deviation guards)  
- [ ] **Create 3 pools** (cbBTC/USDC, fee=0) & **initialize** at oracle price  
- [ ] **Seed liquidity**: tight **primary** range + tiny **fallback** range for each pool  
- [ ] Make arbs find you: contract **verification**, **Subgraph**, `RebalanceNeeded` event, **Solver Kit**  
- [ ] Implement **MEV‑as‑LP incentives** (rebates in deposited asset; LPP retention)  
- [ ] Frontend/API: router prefers **A/B/C (0‑fee)**, metrics & drift badge  
- [ ] Tests: zero‑fee math, range flips, oracle failure, MEV recenter sim, **rebate logic**  
- [ ] Deploy to Base, verify, publish docs, and announce to searchers

---

## 1. Repos & Licensing

- Fork **core** (Factory, PoolDeployer, Pool) and **periphery** (NonfungiblePositionManager, Router).
- Keep GPL headers/NOTICE intact.  
- Publish periphery as **`@hpm/lpp-periphery`** (router helpers, mint helpers, utilities).  
- Pin toolchain versions; add CI.

---

## 2. Zero‑Fee Tier (Factory & Math)

- Expose owner‑gated `enableFeeAmount(uint24 fee, int24 tickSpacing)` and call it with **`fee = 0`** and a **tickSpacing** (e.g., `10`).  
- Audit Pool/SwapMath to ensure **fee=0** → no fee accrual & no div‑by‑zero paths.  
- Unit tests: swap through a 0‑fee pool and assert `feeGrowthGlobal{0,1}X128 == 0`.

---

## 3. Governance & Safety

- Owner of Factory/params = **Safe** (2–3 signers).  
- **Protocol swap fee disabled** (LP fee is 0 ⇒ protocol slice must be 0).  
- Optional **LPPRouter** (front‑door) with a **pause** flag (core pools stay permissionless).

---

## 4. Oracle Adapter (USD → raw token amounts)

Implement **`LPPOracleAdapter`**:
- Reads **BTC/USD** (e.g., Chainlink).  
- Guardrails: **staleness** (`now - updatedAt <= maxAge`) & **max deviation** vs last good price.  
- Helpers (cbBTC **8d**, USDC **6d**):

```
usdcRaw(USD)  = USD * 10^6
cbBtcRaw(USD) = floor((USD * 10^8) / P)   // P = BTC price in USD, scaled to 1e8 (normalize to your feed)
```

---

## 5. Create & Initialize the Three Pools (fee=0)

- Token order: `token0 = cbBTC` (8d), `token1 = USDC` (6d).  
- `factory.createPool(token0, token1, 0)` then initialize at oracle price:

```
price = USDC per 1 cbBTC (scaled)
sqrtPriceX96 = encodeSqrtRatioX96(price * 10^(dec1 - dec0))
pool.initialize(sqrtPriceX96)
```

---

## 6. Seed Liquidity (primary + fallback)

Goal: **always quote** and create tiny profitable drifts for external MEV.

- **Pool A (anchor):** USDC = **$100**, cbBTC ≈ **$100** (≈ 0.001 cbBTC)  
- **Pool B (mid):**    USDC = **$50**,  cbBTC ≈ **$50**  (≈ 0.0005 cbBTC)  
- **Pool C (thin):**   USDC = **$25**,  cbBTC ≈ **$25**  (≈ 0.00025 cbBTC)

For each pool:
- **Primary position:** ultra‑narrow (≈ ±1–2 ticks) around oracle tick.  
- **Fallback position:** tiny, very wide range to prevent “no‑liquidity” states.  
- Mint via **NonfungiblePositionManager** (wrapped in **`@hpm/lpp-periphery`** helpers).

*(Optional)* micro‑offsets to create a tiny internal A↔C spread (−5 bps / 0 / +5 bps).

---

## 7. External MEV Re‑Centering (no swap bounties)

- Choose a **drift threshold** `ε` (e.g., **20–30 bps**) vs oracle.  
- If `|drift| > ε`, searchers arb: buy cheap from your 0‑fee pool and sell on fee’d venues (or A↔C internally).  
- **Fallback range** guarantees quotability for immediate execution.

---

## 8. Discovery & Solver Adoption

- **Verify** contracts on BaseScan so indexers fetch ABIs/decimals.  
- Ship a **Subgraph** (pools, slot0, liquidity, twap, **drift vs oracle**).  
- Emit **`RebalanceNeeded(int256 driftBps)`** on threshold breach.  
- Publish a **Solver Kit** (TS + Foundry): `getPoolStates()`, `getOraclePrice()`, `computeDriftAndSize()`, and private bundle templates.

---

## 9. **MEV‑as‑LP Incentives** (rebates in supplied asset; LPP retention)

> Make searchers *also* LPs without introducing swap fees. Rebates are paid in **the same asset(s) they supply** (USDC and/or cbBTC). LPP retains a fraction of each rebate to fund ops and long‑term liquidity.

### 9.1 Contracts

- **`LPPRebateVault`** (per‑asset vault: **USDC**, **cbBTC**)  
  - Holds rebate reserves (funded by mint surcharges + scheduled top‑ups).  
  - Pays rebates **in‑kind** (USDC/cbBTC) to qualifying LP mints.  
  - Emits `RebatePaid(lp, pool, asset, amount, tier, tvlBefore, tvlAfter)`.

- **`LPPMintHook`** (wrapper around NonfungiblePositionManager)  
  - Computes **eligible rebate tier** at mint time.  
  - **Skims** the surcharge that funds rebates & LPP retention **off‑pool** (does *not* touch swap fees).  
  - Notifies `LPPRebateVault` to disburse **rebate to LP** and **retention to LPP treasury**.

- **`LPPTreasury`**  
  - Receives the LPP retention.
  - Can route a fraction back to **Protocol Owned Liquidity (POL)** mints in A/B/C.

### 9.2 Eligibility

An LP mint qualifies when **any** is true:
- Occurs inside a **Rebalance Window** (N blocks after `RebalanceNeeded` event).  
- The mint **adds ≥ X% of current pool TVL** (sized to the pool where minted).  
- The position centers within **δ ticks** of oracle at time of mint.

### 9.3 Tiered **Deposit‑Share → Rebate** Schedule (examples)

Let `S = minted value / pool TVL at mint` (in USD using adapter).

| Tier | S (share of TVL) | **LP Rebate** (paid in the asset(s) deposited) | **LPP Retention** (same asset mix) |
|------|------------------:|:-----------------------------------------------:|:----------------------------------:|
| T1   |   5%  – <10%      | **1.0%** of minted notional                     | **0.5%**                           |
| T2   |  10%  – <20%      | **2.0%**                                        | **1.0%**                           |
| T3   |  20%  – <35%      | **3.5%**                                        | **1.5%**                           |
| T4   |  35%  – <50%      | **5.0%**                                        | **2.0%**                           |
| T5   |  ≥50% (capped)    | **6.0%**                                        | **2.5%**                           |

- **Denomination:** If the LP supplies 60% USDC / 40% cbBTC, the rebate & retention split **60/40** in the same assets.  
- **Caps:** Per‑mint and per‑epoch caps in the vault prevent exhaustion.  
- **Vesting:** Optional 1–24h vest; early burn/slash recovers the unvested rebate.

### 9.4 Funding (no swap fee needed)

- **Mint Surcharge (off‑pool):** on qualifying mints, route **(Rebate + Retention)** from the minter’s provided amounts **before** adding the remainder as liquidity.  
  - Example: at T2, **3%** of the provided assets are split **2% to LP (rebate)** and **1% to LPP (retention)**; **97%** goes into the pool.  
- **Epoch Top‑Ups (optional):** LPP treasury or partners can add to `LPPRebateVault` to keep tiers active during thin periods.  
- **TVL‑Growth Trigger (optional):** if weekly TVL ↑ by **≥5%**, auto‑emit a small “growth rebate” drip to recent MEV‑LPs.

### 9.5 Anti‑Gaming

- **Hold Period:** rebate vests only if the position remains within **±K ticks** for **T** blocks.  
- **Exit Cliff:** withdrawing >X% within **T/2** slashes the unvested portion.  
- **Rate‑Limiter:** per‑address cool‑down to prevent wash mints.

---

## 10. Routing & UI

- **LPPRouter** prefers A/B/C 0‑fee pools and cascades to public pools if the order size exceeds your tight ranges.  
- `/quote` API exposes best path and a **drift badge**.  
- UI: pool composition gauges, “oracle drift” pill, and **MEV‑as‑LP** banner with current tiers & remaining vault liquidity.

---

## 11. Tests (must pass before mainnet)

- **Zero‑fee math:** no fee growth after swaps.  
- **Range behavior:** when primary goes one‑sided, fallback still quotes.  
- **Oracle guards:** stale/invalid → router can HOLD.  
- **MEV sim:** external move + backrun → pools return within `ε`.  
- **Rebate unit tests:** tiers, vesting, slashing, per‑epoch caps, multi‑asset splits.  
- **Economic sim:** volume vs vault depletion, dilution under many small mints.

---

## 12. Deployment Plan (Base)

1. Deploy **Factory/Core**, call `enableFeeAmount(0, tickSpacing)` (e.g., `10`).  
2. Deploy **`@hpm/lpp-periphery`** (router + position helpers).  
3. Deploy **LPPOracleAdapter** and wire feed/guards.  
4. Deploy **LPPRebateVault**, **LPPMintHook**, **LPPTreasury**; grant roles.  
5. **Create** Pools A/B/C; **initialize** at oracle price.  
6. **Seed** primary + fallback positions (adapter‑computed amounts).  
7. **Verify** contracts; publish **Subgraph** & **Solver Kit**; announce to searchers.

---

## 13. Amounts & Math (copy/paste)

```
DECIMALS:
  cbBTC = 8
  USDC  = 6

Given BTC/USD price P (scaled to 1e8):

usdcRaw(USD)  = USD * 10^6
cbBtcRaw(USD) = floor((USD * 10^8) / P)

Seed targets:
  Pool A: USDC = usdcRaw(100), cbBTC = cbBtcRaw(100)
  Pool B: USDC = usdcRaw(50),  cbBTC = cbBtcRaw(50)
  Pool C: USDC = usdcRaw(25),  cbBTC = cbBtcRaw(25)

Initialize (token0 = cbBTC, token1 = USDC):
  sqrtPriceX96 = encodeSqrtRatioX96(price * 10^(dec1 - dec0))
```

---

## 14. Minimal Helper Interfaces (optional)

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
