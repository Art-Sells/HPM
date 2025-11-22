# LPP Phase 0 — MEV / Searcher Integration (Mainnet-Focused)

This guide is for **real deployments** (e.g. Base mainnet).  We are wiring six pools, dual 3-hop orbits, and the LPPRouter daily-cap guard exactly as implemented in `contracts/`.  Local Hardhat reproductions are optional; validation happens against live infrastructure.

---

## 1. Pre-Deployment:

- **Chain + RPC**: *Insert target chain (e.g., Base mainnet) and RPC endpoint here*
  - Primary RPC: `*insert RPC URL here*`
  - Fallback RPC: `*insert fallback RPC URL here*` (optional)

- **Tokens**:
  - ASSET address: `*insert ASSET token address here*`
  - USDC address: `*insert USDC token address here*` (must be 1:1 reference price with ASSET)

- **Operators**:
  - `treasuryOwner`: `*insert cold wallet address here*` (controls LPPTreasury, should be multisig/cold storage)
  - `treasuryOps`: `*insert warm wallet address here*` (executes bootstraps, must be approved supplicator)

- **Router fees**: Hard-coded in contract (no action needed)
  - `MCV_FEE_BPS=120` (1.2% per hop)
  - `TREASURY_CUT_BPS=20` (0.2% of hop input)
  - `POOLS_DONATE_BPS=100` (1% of hop input)

- **Daily cap**: `*insert number here*` events/day UTC (default: 500, adjustable via `setDailyEventCapViaTreasury`)

- **Pool topology**: Six pools with identical assets
  - NEG orbit: 3 pools at −500 bps offset
  - POS orbit: 3 pools at +500 bps offset

- **Seed TVL**: `*insert amount here*` ASSET + `*insert amount here*` USDC per pool (minimum: 100 each, scale symmetrically)

After deployment, publish these values + final contract addresses so searchers and relays have a single source of truth.

---

## 2. Deploy & Wire Contracts (On-Chain Only)

1. Deploy `LPPAccessManager` → `LPPTreasury` → `LPPFactory` → `LPPRouter(accessManager, treasury)`.
2. Transfer treasury ownership to `treasuryOwner` and whitelist `treasuryOps` via `accessManager.setApprovedSupplicator`.
3. Record all addresses (AccessManager/Treasury/Factory/Router/ASSET/USDC) in your deployment manifest.

No local verification is needed; the above must happen on the target chain.

---

## 3. Build the Six-Pool Topology

1. **Create pools**
   ```solidity
   address pool = factory.createPool(asset, usdc, offsetBps);
   ```
   Create three pools at −500 bps and three at +500 bps. Label them Pool0–Pool5 for reference.

2. **Bootstrap**
   From `treasuryOps` (approved supplicator):
   ```solidity
   ILPPPool(pool).bootstrapInitialize(100 ether, 100 ether, offsetBps);
   ```
   Adjust the amounts if you want deeper liquidity, but keep NEG vs POS symmetric.

3. **Register dual orbits**
   Use the treasury forwarder so the router’s `onlyTreasury` check passes:
   ```solidity
   treasury.setDualOrbitViaTreasury(
     address(router),
     pool0,                        // startPool key advertised to searchers
     [pool0,pool1,pool2],          // NEG orbit  (ASSET → USDC)
     [pool3,pool4,pool5],          // POS orbit  (USDC → ASSET)
     true                          // start with NEG
   );
   ```
   The router flips `useNegNext` after every swap.

4. **(Optional) Set daily cap**
   ```solidity
   treasury.setDailyEventCapViaTreasury(address(router), 500);
   ```

---

## 4. MEV Execution Surface (Live Chain)

1. **Quote** with `router.getAmountsOutFromStart(startPool, amountIn)` to learn which orbit (NEG or POS) is next and what each hop outputs.
2. **Approvals**: router needs the per-hop fee; each pool in the active orbit needs allowance for the hop principal.
3. **Swap params**: build `SwapParams` with the advertised `startPool`, `amountIn`, and a realistic `minTotalAmountOut`. When the dual orbit is configured, `assetToUsdc` is ignored.
4. **Submit bundle**: encode calldata via `router.interface.encodeFunctionData("swap", [params])`, sign with the searcher key, forward to your relay/builder, and broadcast to the chain once accepted.
5. **Observe guardrails**:
   - `DailyEventCapReached(cap)` fires once `dailyEventCount >= dailyEventCap`.
   - `OrbitFlipped(startPool, nowUsingNeg)` tells you which path will execute next.
   - `FeeTaken` + `HopExecuted` let you reconstruct execution in real time.

Everything above happens against the production network; there is no expectation to run Hardhat or the local mev-boost harness.

---

## 5. On-Chain Validation Plan

1. **Dry-run on staging (optional)**: Deploy a low-liquidity copy on a public testnet and run a few bundles end-to-end with your production bot stack to make sure signing, relays, and monitoring work.

2. **Production smoke tests**:
   - Submit a minimal ASSET→USDC bundle; confirm three `HopExecuted` events and that treasury receives roughly 0.2% of the input per hop.
   - Immediately submit the mirror USDC→ASSET bundle; verify `OrbitFlipped` toggled and reserves updated symmetrically.
   - Hit the configured daily cap, observe the revert, wait 24h (UTC) and confirm `router.getDailyEventWindow()` shows the counter reset.

3. **Monitoring requirements**:
   - Continuously poll `router.getDailyEventWindow()`.
   - Track `ILPPPool.reserveAsset` / `reserveUsdc` per pool to catch drift.
   - Index `FeeTaken`, `HopExecuted`, `OrbitFlipped`, `DailyEventCapUpdated`, and `DailyEventWindowRolled` for dashboards and alerting.

---

## 6. Packaging for External Searchers

- Publish ABI + addresses + the parameter file from Section 1.
- Ship a lightweight SDK or script that:
  1. Fetches the next orbit via `getAmountsOutFromStart`.
  2. Builds calldata and target blocks for the relay.
  3. Handles revert reasons (`DailyEventCapReached`, slippage) so bundles aren’t spammed.
- Communicate any cap changes via `DailyEventCapUpdated` events or public status pages.
- Adjust bps fees if needed (low or high)

By sticking to this playbook we can take the contracts live, observe them directly on-chain, and give MEV partners a single, deterministic integration surface—without relying on local testing infrastructure.  Update this document every time offsets, fee splits, or guardrails change so downstream teams stay synchronized.
