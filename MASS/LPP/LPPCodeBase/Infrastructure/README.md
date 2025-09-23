# LPPv1 Infrastructure — Blueprint

## Progress Checklist

- [X] Dismantle and rebuild [Protocol](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Protocol) & [Preriphery](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Periphery): **Complete**
- [ ] Configure and compile [Protocol](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Protocol) & [Preriphery](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Periphery): ***In-Progress***
- [ ] Enable **fee = 0** tier in Factory; add **fee=0 math tests**
- [ ] Set governance (**Safe multisig**); protocol swap fee **disabled**
- [ ] Implement **LPPOracleAdapter** (BTC/USD with staleness & deviation guards)
- [ ] **Create 3 pools** (cbBTC/USDC, fee=0) & **initialize** at oracle price
- [ ] **Seed liquidity**: tight **primary** range + tiny **fallback** range for each pool
- [ ] **LPPRouter.recenterAndMint()** (atomic: price re‑center **and** LP mint in one tx)
- [ ] Make arbs find pools: contract **verification**, **Subgraph**, `RebalanceNeeded` event, **Solver Kit**
- [ ] Implement **MEV‑as‑LP rebates** (in‑kind, diminishing returns) with **LPP retention**
- [ ] **Wire 1% profit‑share via JS** (off‑chain orchestrator; no on‑chain logic changes)
- [ ] Frontend/API: router prefers **A/B/C (0‑fee)**, metrics & drift badge
- [ ] Tests: zero‑fee math, range flips, oracle failure, **atomic recenter & rebate logic**
- [ ] Deploy to Base, verify, publish docs, announce to searchers

---

## 1. Repos & Licensing

- Fork **core** (Factory, PoolDeployer, Pool) and **periphery** (NonfungiblePositionManager, Router).  
- Keep GPL/NOTICE headers intact.  
- Publish periphery as **`@hpm/lpp-periphery`** (router helpers, mint helpers, utilities).  
- Pin toolchain (Foundry/Hardhat); add CI.

---

## 2. Zero‑Fee Tier (Factory & Math)

- Expose owner‑gated `enableFeeAmount(uint24 fee, int24 tickSpacing)` and call with **`fee = 0`**, **tickSpacing = 10** (example).  
- Audit Pool/SwapMath: **fee=0** ⇒ no fee accrual & no div‑by‑zero anywhere.  
- Tests: swap through 0‑fee pool and assert `feeGrowthGlobal{0,1}X128 == 0` and protocol fee paths are inert.

---

## 3. Governance & Safety

- Factory/params owner = **Safe** (2–3 signers).  
- **Protocol swap fee disabled** (LP fee is 0 ⇒ protocol slice must be 0).  
- Optional **LPPRouter** pause flag (core pools stay permissionless).

---

## 4. Oracle Adapter (USD → raw token amounts)

**`LPPOracleAdapter`**:  
- Source: **BTC/USD** (e.g., Chainlink).  
- Guards: **staleness** (`now - updatedAt <= maxAge`) & **max deviation** vs last good price.  
- Helpers (cbBTC **8d**, USDC **6d**):
```txt
usdcRaw(USD)  = USD * 10^6
cbBtcRaw(USD) = floor((USD * 10^8) / P)   // P = BTC price in USD, scaled to 1e8
```

---

## 5. Create & Initialize the Three Pools (fee=0)

- Token order: `token0 = cbBTC (8d)`, `token1 = USDC (6d)`.  
- `factory.createPool(token0, token1, 0)`, then:
```txt
price = USDC per 1 cbBTC (scaled)
sqrtPriceX96 = encodeSqrtRatioX96(price * 10^(dec1 - dec0))
pool.initialize(sqrtPriceX96)
```

---

## 6. Seed Liquidity (primary + fallback)

**Goal:** always quote and create tiny profitable drifts for external MEV (to re‑center).

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

## 7. **Atomic recenterAndMint** (one‑tx: re‑center price **and** LP)

### 7.1 Router Entry
```solidity
function recenterAndMint(
  address pool,
  uint256 maxIn0,
  uint256 maxIn1,
  uint16  minImproveBps,     // required improvement vs oracle
  MintParams calldata mint   // tickLower, tickUpper, amounts, recipient
) external returns (uint256 tokenId, uint8 tierApplied, uint16 improveBps);
```

### 7.2 Execution Flow
1. Read oracle & pool `slot0`; compute current **drift** (in bps).  
2. Compute the **direction and size** of the internal 0‑fee swap to move price **toward** oracle (bounded by `maxIn{0,1}`).  
3. Execute swap on the LPP pool.  
4. Recompute drift; require improvement **≥ `minImproveBps`** (revert otherwise).  
5. Immediately call `LPPMintHook.mintWithRebate(mint)` to add narrowly‑centered liquidity (±1–2 ticks).  
6. Hook calculates tier (diminishing returns), pays **rebate in‑kind**, sends **retention** to treasury.  
7. Emit `RecenteredAndMinted(lp, pool, improveBps, usdNotional, tierApplied)`.

> *(Optional)* Whitelist a single **external call** inside the router to settle the “other leg” (e.g., sell on a fee’d AMM) so the whole arb + mint is atomic.

---

## 8. MEV‑as‑LP Rebates (in‑kind, **diminishing returns**, anti‑centralization)

Let `S = minted notional / pool TVL at mint` (USD via adapter).  
Rebate paid in **the same asset mix** deposited (USDC/cbBTC). LPP keeps a fraction (**retention**) to fund ops/POL.

| Tier | S (share of TVL) | **LP Rebate** | **LPP Retention** |
|-----:|------------------:|:-------------:|:-----------------:|
| T1   | 5% – <10%         | **1.0%**      | **0.5%**          |
| T2   | 10% – <20%        | **1.8%**      | **0.9%**          |
| T3   | 20% – <35%        | **2.5%**      | **1.25%**         |
| T4   | ≥50% (capped)     | **3.5%**      | **1.75%**         |

**Guards & UX:**
- **Centered‑only**: mint must be within **±δ ticks** of oracle.  
- **Per‑mint/epoch caps** to prevent vault exhaustion.  
- **Short vesting** (e.g., 1–24h) and **hold** requirement; early large withdraw slashes unvested rebate.  
- **Rate‑limit** per address; Sybil heuristics (optional).

**Funding (no swap fees):**
- **Mint surcharge (off‑pool):** at mint time, skim `(rebate + retention)` from submitted tokens; the **remainder** is added as liquidity.  
- **Epoch top‑ups:** treasury/partners can replenish `LPPRebateVault` if needed.  
- **Growth drip (optional):** if weekly TVL ↑ ≥5%, drip small bonus to recent MEV‑LPs.

---

## 9. 1% Profit‑Share — Off‑Chain JS (mutable)

- JS service reads realized user P&L and routes **1%** into a MEV rewards pot (USDC/cbBTC).  
- Scores: re‑center events, LP hold time, volume.  
- Payouts from **LPPTreasury** (or Safe) to MEV addresses; produce Merkle snapshots.

---

## 10. Discovery & Solver Adoption

- Verify contracts on **BaseScan** (ABIs/decimals).  
- **Subgraph**: pools, slot0, liquidity, TWAP, **drift vs oracle**.  
- Emit **`RebalanceNeeded(int256 driftBps)`** when crossing threshold.  
- **Solver Kit** (TS + Foundry): examples for computing drift, sizing `maxIn`, and calling `recenterAndMint` atomically.

---

## 11. Tests

- **Zero‑fee math** invariant.  
- **Atomic flow**: swap improves drift ≥ `minImproveBps`, then mint; combined revert if either fails.  
- **Rebate math**: tiers, diminishing returns, vesting/slash, per‑epoch caps.  
- **Economic sim**: dilution under many small mints; vault longevity vs TVL growth.  
- **Oracle safety**: staleness/deviation; HOLD mode.  

---

## 12. Deployment Plan (Base)

1. Deploy **Factory/Core**; `enableFeeAmount(0, tickSpacing=10)`.  
2. Deploy **`@hpm/lpp-periphery`** (router + mint helpers).  
3. Deploy **LPPOracleAdapter**; wire feed & guards.  
4. Deploy **LPPRebateVault**, **LPPMintHook**, **LPPTreasury**; set roles.  
5. **Create** Pools A/B/C; **initialize** at oracle price.  
6. **Seed** primary + fallback positions (adapter‑computed).  
7. Verify contracts; publish **Subgraph** & **Solver Kit**; announce to searchers.  
8. Stand up **JS Profit‑Share** service; point at Safe/Treasury.

---

## 13. Amounts & Math

```txt
DECIMALS:
  cbBTC = 8
  USDC  = 6

Given BTC/USD price P (scaled to 1e8):

usdcRaw(USD)  = USD * 10^6
cbBtcRaw(USD) = floor((USD * 10^8) / P)

Seed targets:
  Pool A: USDC = usdcRaw(100), cbBTC = cbBtcRaw(100)    // ≈ 0.001 cbBTC
  Pool B: USDC = usdcRaw(50),  cbBTC = cbBtcRaw(50)     // ≈ 0.0005 cbBTC
  Pool C: USDC = usdcRaw(25),  cbBTC = cbBtcRaw(25)     // ≈ 0.00025 cbBTC

Initialize (token0 = cbBTC, token1 = USDC):
  sqrtPriceX96 = encodeSqrtRatioX96(price * 10^(dec1 - dec0))
```

---

## 14. Minimal Interfaces (excerpt)

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

interface ILPPRouter {
  function recenterAndMint(
    address pool,
    uint256 maxIn0,
    uint256 maxIn1,
    uint16  minImproveBps,
    ILPPMintHook.MintParams calldata mint
  ) external returns (uint256 tokenId, uint8 tierApplied, uint16 improveBps);
  event RecenteredAndMinted(address indexed lp, address indexed pool, uint16 improveBps, uint256 usdNotional, uint8 tier);
}
```
