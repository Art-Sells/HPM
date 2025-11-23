# LPP Phase 0 — MEV / Searcher Integration (Mainnet-Focused)

This guide is for **real deployments** (e.g. Base mainnet).  We are wiring four pools, dual 2-hop orbits, and the LPPRouter daily-cap guard exactly as implemented in `contracts/`.  Local Hardhat reproductions are optional; validation happens against live infrastructure.

---

## 1. Pre-Deployment:

- **Chain**: *Base Mainnet*
  - Primary RPC: `*https://base-mainnet.infura.io/v3/4885ed01637e4a6f91c2c7fcd1714f68*`

- **Tokens**:
  - ASSET (cbBTC) address: `*0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf*`
  - USDC address: `*0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913*` (must be 1:1 reference price with ASSET)

- **Operators**:
  - `treasuryOwner` + `treasuryOps`: `*0xd9a6714bba0985b279dfcaff0a512ba25f5a03d1*` (controls LPPTreasury, executes bootstraps, and approves supplicators)

- **Router fees**: Hard-coded in contract (no action needed)
  - `MCV_FEE_BPS=120` (1.2% per hop)
  - `TREASURY_CUT_BPS=20` (0.2% of hop input)
  - `POOLS_DONATE_BPS=100` (1% of hop input)

- **Daily cap**: `*500*` events/day UTC (default: 500, adjustable via `setDailyEventCapViaTreasury`)

- **Pool topology**: Four pools with identical assets
  - NEG orbit: 2 pools at −500 bps offset
  - POS orbit: 2 pools at +500 bps offset

- **Seed TVL**: `*.000012*` ASSET (cbBTC) + `*1*` USDC per pool

After deployment, publish these values + final contract addresses so searchers and relays have a single source of truth.

---

## 2. Deploy & Wire Contracts (On-Chain Only)

1. Deploy `LPPAccessManager` → `LPPTreasury` → `LPPFactory` → `LPPRouter(accessManager, treasury)`.
2. Transfer treasury ownership to `treasuryOwner` and whitelist `treasuryOps` via `accessManager.setApprovedSupplicator`.
3. Record all addresses (AccessManager/Treasury/Factory/Router/ASSET/USDC) in your deployment manifest.

No local verification is needed; the above must happen on the target chain.

---

## 3. Build the Four-Pool Topology

1. **Create pools**
   ```solidity
   address pool = factory.createPool(asset, usdc);
   ```
   Create 2 pools at −500 bps and 2 pools at +500 bps. Label them Pool0–Pool3 for reference:
   - Pool0, Pool1: NEG orbit (−500 bps)
   - Pool2, Pool3: POS orbit (+500 bps)

2. **Bootstrap**
   From `treasuryOps` via treasury:
   ```solidity
   treasury.bootstrapViaTreasury(pool, amountAsset, amountUsdc, offsetBps);
   ```
   Bootstrap each pool with the appropriate offset:
   - Pool0, Pool1: `offsetBps = -500`
   - Pool2, Pool3: `offsetBps = +500`
   Adjust the amounts if you want deeper liquidity, but keep NEG vs POS symmetric.

3. **Register dual orbits**
   Use the treasury forwarder so the router's `onlyTreasury` check passes. **Register the same orbit configuration under ALL pool addresses** so searchers can use any pool as the `startPool` lookup key:
   
   ```solidity
   // Register the same orbit config under all 4 pools
   address[] memory negOrbit = new address[](2);
   negOrbit[0] = pool0;  // NEG: -500 bps
   negOrbit[1] = pool1;  // NEG: -500 bps
   
   address[] memory posOrbit = new address[](2);
   posOrbit[0] = pool2;  // POS: +500 bps
   posOrbit[1] = pool3;  // POS: +500 bps
   
   // Register under each pool address so searchers can start from any pool
   address[4] memory allPools = [pool0, pool1, pool2, pool3];
   for (uint i = 0; i < 4; i++) {
     treasury.setDualOrbitViaTreasury(
       address(router),
       allPools[i],                 // startPool: any pool can be used as lookup key
       negOrbit,                    // NEG orbit: 2 pools (pool0, pool1)
       posOrbit,                    // POS orbit: 2 pools (pool2, pool3)
       true                          // deprecated: kept for backwards compatibility
     );
   }
   ```
   **Important Notes**:
   - The router contract now supports **variable-length orbits** (any number of pools).
   - The `startPool` is a **lookup key** to identify the orbit configuration. By registering the same orbit config under all pool addresses, searchers can use **any pool address** as `SwapParams.startPool`.
   - Searchers choose which orbit to use via the `assetToUsdc` parameter in `SwapParams`:
     - `assetToUsdc: true` → NEG orbit (pool0, pool1 - 2 pools)
     - `assetToUsdc: false` → POS orbit (pool2, pool3 - 2 pools)
   - **Example**: If a searcher uses `pool2` (a POS pool) as `startPool` but sets `assetToUsdc: true`, they will swap through the NEG orbit (pool0, pool1).
   - After each swap, all pools in the chosen orbit will have their offsets flipped (e.g., -500 bps → +500 bps, or vice versa).

4. **(Optional) Set daily cap**
   ```solidity
   treasury.setDailyEventCapViaTreasury(address(router), 500);
   ```

---

## 4. MEV Execution Surface (Live Chain)

1. **Quote** with `router.getAmountsOutFromStartWithDirection(startPool, amountIn, useNegOrbit)` to get quotes for a specific orbit, or use `router.getAmountsOutFromStart(startPool, amountIn)` for the default (NEG orbit).
2. **Choose orbit**: Set `assetToUsdc` in `SwapParams` to select which orbit to use:
   - `assetToUsdc: true` → NEG orbit (all -500 bps pools, ASSET → USDC)
   - `assetToUsdc: false` → POS orbit (all +500 bps pools, USDC → ASSET)
3. **Approvals**: router needs the per-hop fee; each pool in the chosen orbit needs allowance for the hop principal.
4. **Swap params**: build `SwapParams` with:
   - `startPool`: **Any pool address** that was registered in `setDualOrbit` (this is just the lookup key to find the orbit config; the actual swap goes through the chosen orbit)
   - `amountIn`: The input amount (same amount used for all hops in the orbit)
   - `assetToUsdc`: Your orbit choice (true = NEG orbit, false = POS orbit) - **this determines which pools you swap through, regardless of which pool you use as `startPool`**
   - `minTotalAmountOut`: Realistic slippage protection
   - The swap will execute through **all pool addresses** in the chosen orbit sequentially (e.g., 2 pools for a 2-pool orbit)
5. **Submit bundle**: encode calldata via `router.interface.encodeFunctionData("swap", [params])`, sign with the searcher key, forward to your relay/builder, and broadcast to the chain once accepted.
6. **Observe guardrails**:
   - `DailyEventCapReached(cap)` fires once `dailyEventCount >= dailyEventCap`.
   - `OrbitFlipped(startPool, usedNegOrbit)` indicates which orbit was used (true = NEG, false = POS).
   - `OffsetFlipped(newOffset)` is emitted by each pool after a swap, showing the new offset after flipping.
   - `FeeTaken` + `HopExecuted` let you reconstruct execution in real time.

Everything above happens against the production network; there is no expectation to run Hardhat or the local mev-boost harness.

---

## 5. On-Chain Validation Plan

1. **Dry-run on staging (optional)**: Deploy a low-liquidity copy on a public testnet and run a few bundles end-to-end with your production bot stack to make sure signing, relays, and monitoring work.

2. **Production smoke tests**:
   - Submit a minimal ASSET→USDC bundle (with `assetToUsdc: true` to use NEG orbit); confirm `HopExecuted` events for pool0 and pool1 (2 events total), that treasury receives roughly 0.2% of the input per hop, and that both NEG orbit pools (pool0, pool1) have their offsets flipped (from -500 to +500 bps).
   - Immediately submit the mirror USDC→ASSET bundle (with `assetToUsdc: false` to use POS orbit); verify `OrbitFlipped` indicates POS orbit was used, confirm `HopExecuted` events for pool2 and pool3 (2 events total), reserves updated symmetrically, and both POS orbit pools (pool2, pool3) have their offsets flipped (from +500 to -500 bps).
   - Hit the configured daily cap, observe the revert, wait 24h (UTC) and confirm `router.getDailyEventWindow()` shows the counter reset.

3. **Monitoring requirements**:
   - Continuously poll `router.getDailyEventWindow()`.
   - Track `ILPPPool.reserveAsset` / `reserveUsdc` per pool to catch drift.
   - Index `FeeTaken`, `HopExecuted`, `OrbitFlipped`, `OffsetFlipped` (from pools), `DailyEventCapUpdated`, and `DailyEventWindowRolled` for dashboards and alerting.

---

## 6. Packaging for External Searchers

- Publish ABI + addresses + the parameter file from Section 1.
- Ship a lightweight SDK or script that:
  1. Allows searchers to choose their orbit (NEG or POS) based on market conditions.
  2. Fetches quotes for the chosen orbit via `getAmountsOutFromStartWithDirection(startPool, amountIn, useNegOrbit)`.
  3. Builds calldata with the appropriate `assetToUsdc` value and target blocks for the relay.
  4. Handles revert reasons (`DailyEventCapReached`, slippage) so bundles aren't spammed.
- Communicate any cap changes via `DailyEventCapUpdated` events or public status pages.
- Adjust bps fees if needed (low or high)

By sticking to this playbook we can take the contracts live, observe them directly on-chain, and give MEV partners a single, deterministic integration surface—without relying on local testing infrastructure.  Update this document every time offsets, fee splits, or guardrails change so downstream teams stay synchronized.
