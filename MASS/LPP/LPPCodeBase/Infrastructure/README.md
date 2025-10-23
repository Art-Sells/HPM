# LPPv1 Infrastructure — Blueprint

## Progress Checklist

- [x] Dismantle and rebuild [Protocol](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Protocol) & [Periphery](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Periphery): **Complete**
- [x] Configure and compile [Protocol](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Protocol) & [Periphery](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP/LPPCodeBase/Infrastructure/Periphery): **Complete**
- [x] Enable & test **fee = 0** tier in Factory; add **fee=0 math tests** — **Complete**: [LPPZeroFeeSpec](https://github.com/Art-Sells/HPM/blob/main/MASS/LPP/LPPCodeBase/Infrastructure/Protocol/test/LPPFactory.spec.ts)
- [ ] Test all other tests inside Protocol & Periphery folders — **In-Progress**
  - [ ] Remove the word **"your" and "swap"** from all files
  - [ ] Delete all **snapshots**, recompile and re-test Periphery and Protocol
- [ ] **Might not need:** Set governance (**Safe multisig**); protocol swap fee **disabled**
- [ ] **There’s already an Oracle Adapter (delete if redundant):** Implement **LPPOracleAdapter** (cbBTC/USDC with staleness & deviation guards)
- [ ] **Might not need (automatic):** **LPPRouter.recenterAndMint()** (atomic: price re-center **and** LP mint) *(don’t forget nft.mint)*
- [ ] Implement **MEV-as-LP rebates** (in-kind, diminishing returns) with **LPP retention**
  - [ ] May require restructuring **LPPPool.sol** and **LPPFactory**; add MEV-as-LP tests to pool specs
- [ ] Frontend/API: router prefers **A/B/C (0-fee)**, metrics & drift badge
- [ ] Test: zero-fee math, range flips, oracle failure, **atomic recenter & rebate logic**
- [ ] **Create 3 pools** (cbBTC/USDC, fee=0) & **initialize** at oracle price
- [ ] **Seed liquidity**: tight **primary** range + tiny **fallback** range for each pool
- [ ] Make arbs find pools: contract **verification**, **Subgraph**, `RebalanceNeeded` event, **Solver Kit**
- [ ] Deploy to Base, test with Base Testnet hardhat config (BASE_RPC_URL), verify, publish docs, announce to searchers

---

## 1. Protocol & Periphery (Repos, Licensing, CI) — ✅ Done

- Create **protocol** (Factory, PoolDeployer, Pool) and **periphery** (NonfungiblePositionManager, Router).  
- Keep GPL/NOTICE headers intact.  
- Publish periphery/protocol as **`@/periphery`** / **`@/protocol`** (router helpers, mint helpers, utilities).  
- Pin toolchain (Foundry/Hardhat); add CI.

---

## 2. Zero-Fee Tier (Factory & Math) — ✅ Done

- Owner-gated `enableFeeAmount(uint24 fee, int24 tickSpacing)` with **`fee = 0`** (e.g., `tickSpacing = 5`).  
- Audit Pool/SwapMath: **fee=0** ⇒ no fee accrual & no div-by-zero.  
- Tests: swap through 0-fee pool and assert `feeGrowthGlobal{0,1}X128 == 0`; protocol fee paths inert.

---

## 3. Test Sweep & Cleanup — 🔄 In-Progress

- Run **all** Protocol & Periphery tests.  
- **Reset artifacts**: delete snapshots; re-run full suite from a clean state.  
- **Text cleanup**: remove **"your"** from all files.  
- Track gas/report diffs; fail CI on unexpected deltas.

---

## 4. Governance & Safety — (optional)

- Factory/params owner = **Safe** (2–3 signers).  
- **Protocol swap fee disabled** (LP fee is 0 ⇒ protocol slice must be 0).  
- Optional **LPPRouter** pause flag (core pools stay permissionless).

---

## 5. Oracle Adapter (USD → raw token amounts) — (skip if already present)

**`LPPOracleAdapter`**:  
- Source: **BTC/USD** (e.g., Chainlink).  
- Guards: **staleness** (`now - updatedAt <= maxAge`) & **max deviation** vs last good price.  
- Helpers (cbBTC **8d**, USDC **6d**):
```txt
usdcRaw(USD)  = USD * 10^6
cbBtcRaw(USD) = floor((USD * 10^8) / P)   // P = BTC price in USD, scaled to 1e8
```

---

## 6. Atomic `recenterAndMint` (one-tx recenter **+** LP) — (likely optional)

### Router Entry
```solidity
function recenterAndMint(
  address pool,
  uint256 maxIn0,
  uint256 maxIn1,
  uint16  minImproveBps,
  MintParams calldata mint
) external returns (uint256 tokenId, uint8 tierApplied, uint16 improveBps);
```

### Flow
1. Read oracle & pool `slot0`; compute **drift** (bps).  
2. Compute internal 0-fee swap (bounded by `maxIn{0,1}`) to move toward oracle.  
3. Execute swap; require improvement **≥ `minImproveBps`**.  
4. Immediately **mint** narrowly-centered liquidity (±1–2 ticks) and emit event.  
5. Hook computes tier, pays **rebate in-kind**, keeps **retention** to treasury.

---

## 7. MEV-as-LP Rebates (diminishing returns)

Let `S = minted notional / pool TVL`. Rebate paid in **asset mix** deposited; **retention** funds ops/POL.

| Tier | S (share of TVL) | **LP Rebate** | **LPP Retention** |
|-----:|------------------:|:-------------:|:-----------------:|
| T1   | 5% – <10%         | **1.0%**      | **0.5%**          |
| T2   | 10% – <20%        | **1.8%**      | **0.9%**          |
| T3   | 20% – <35%        | **2.5%**      | **1.25%**         |
| T4   | ≥50% (cap)        | **3.5%**      | **1.75%**         |

**Guards**: centered-only (±δ ticks), per-mint/epoch caps, short vest/hold, rate-limit per addr.

**Funding (no swap fees):**
- **Mint surcharge:** skim `(rebate + retention)` at mint; remainder becomes liquidity.  
- **Epoch top-ups:** treasury/partners can replenish `LPPRebateVault`.  
- **Growth drip (optional).**

---

## 8. Frontend/API (0-fee first)

- Router prefers **A/B/C 0-fee pools**; display drift badge vs oracle.  
- `/state` endpoint: `{ oraclePrice, pools[{addr, tick, sqrtP, liq}], suggestedMaxIn }`.  
- Gas estimator & calldata builder; dry-run RPC for revert reasons.

---

## 9. Tests (beyond core math)

- **Zero-fee invariants**.  
- **Atomic flow**: swap improves drift ≥ `minImproveBps`, then mint (single-tx).  
- **Rebate math**: tiers, vest/slash, epoch caps.  
- **Oracle safety**: staleness/deviation; HOLD mode.  
- **Range flips** & stress around tick boundaries.

---

## 10. Create & Initialize the Three Pools (fee=0)

- Token order: `token0 = cbBTC (8d)`, `token1 = USDC (6d)`.  
- `factory.createPool(token0, token1, 0)`, then:
```txt
price = USDC per 1 cbBTC (scaled)
sqrtPriceX96 = encodeSqrtRatioX96(price * 10^(dec1 - dec0))
pool.initialize(sqrtPriceX96)
```

---

## 11. Seed Liquidity (primary + fallback)

**Equal seed** via adapter for all pools (example target ≈ $100 each side).

**Primary position:** ultra-narrow (±1–2 ticks).  
**Fallback position:** tiny, wide range to prevent “no-liquidity”.  
Mint via **NonfungiblePositionManager** (use `@/periphery` helpers).

**Center Offsets (vs oracle at seed time):**
- **Pool A:** **−10 bps**
- **Pool B:** **−5 bps**
- **Pool C:** **+15 bps**

> If prices remain off-center post-seed, incrementally increase seeds.

---

## 12. Discovery & Solver Adoption

- **Verify** on BaseScan (ABIs/decimals).  
- **Subgraph**: pools, slot0, liquidity, TWAP, **drift vs oracle**.  
- Emit **`RebalanceNeeded(int256 driftBps)`** when threshold breached.  
- **Solver Kit** (TS + Foundry) + example bot + Dockerfile.

---

## 13. Deployment Plan (Base)

1. Deploy **Factory/Core**; `enableFeeAmount(0, tickSpacing=5)`.  
2. Deploy **`@hpm/lpp-periphery`** (router + mint helpers).  
3. Deploy **LPPOracleAdapter**; wire feed & guards (skip if redundant).  
4. Deploy **LPPRebateVault**, **LPPMintHook**, **LPPTreasury**; set roles.  
5. **Create** Pools A/B/C; **initialize** at oracle price.  
6. **Seed** primary + fallback positions with offsets A −10 bps, B −5 bps, C +15 bps.  
7. Verify contracts; publish **Subgraph** & **Solver Kit**; announce to searchers.  
8. Stand up **JS Profit-Share** service; point at Safe/Treasury.

---

## 14. Amounts & Math (decimals & helpers)

```txt
DECIMALS:
  cbBTC = 8
  USDC  = 6

Given BTC/USD price P (scaled to 1e8):

usdcRaw(USD)  = USD * 10^6
cbBtcRaw(USD) = floor((USD * 10^8) / P)

Equal seed targets (all pools):
  USDC = usdcRaw(100),  cbBTC = cbBtcRaw(100)

Initialize (token0 = cbBTC, token1 = USDC):
  sqrtPriceX96 = encodeSqrtRatioX96(price * 10^(dec1 - dec0))
```

---

## 15. Minimal Interfaces (excerpt)

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
