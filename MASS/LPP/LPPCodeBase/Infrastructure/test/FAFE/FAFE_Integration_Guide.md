# FAFE Integration Guide — Base Mainnet (Live Contracts Only)

This runbook covers the exact actions we still need against the **already deployed** LPP contracts on Base. No redeploys, no local forks—every call in this guide hits the production addresses recorded in `deployment-manifest.json`.

Goal:
- Spin up **one** negative-orbit LPP pool funded with `0.000012` cbBTC at `-5000` bps (USDC side can stay at the default bootstrap amount).
- Skip orbit registration if it fails—we only care about making the pool live.
- From `MASS_TESTER_ADDRESS / MASS_TESTER_KEY`, run a `supplicate` (single-pool pull) that spends `0.50` USDC to withdraw all cbBTC from that pool.
- Snapshot before/after states directly from on-chain reads.

---

## Live deployment (do not redeploy)

| Component | Address / Notes |
| --- | --- |
| Router | `0xFf3049E2275F911b9d9A8F8433F3B59d7b9eA1d1` |
| Treasury | `0x8eF52FD642890f8191021f8a9DCa4f60606F0Bba` |
| Factory | `0xD999f5929a75F305fd496d0b2Df8e6F30dE6606b` |
| AccessManager | `0x9a2e2ce2Cdf7da5161EB894360eed606291AA3d2` |
| cbBTC (ASSET) | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` (8 decimals) |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals) |
| Treasury operator (`treasuryOps`) | `0xd9a6714bba0985b279dfcaff0a512ba25f5a03d1` |
| MASS tester (supplicate signer) | `MASS_TESTER_ADDRESS` / `MASS_TESTER_KEY` |

Environment variables we rely on:

```
BASE_RPC_URL=...
TREASURY_OPS_KEY=...          # controls treasury + factory
MASS_TESTER_ADDRESS=...
MASS_TESTER_KEY=...
```

All Hardhat commands below are run from `Infrastructure/` and target `--network base`.

---

## Step 1 — Create or pick the target pool

1. Ensure both cbBTC + USDC are allow-listed in the existing factory (they should be, but confirm once):
   ```ts
   const manifest = require("../deployment-manifest.json");
   const factory = await ethers.getContractAt("LPPFactory", manifest.contracts.LPPFactory, treasuryOps);
   await factory.setAllowedToken(manifest.tokens.ASSET, true);
   await factory.setAllowedToken(manifest.tokens.USDC, true);
   ```

2. Create a fresh pool (only treasury can call `createPool`):
   ```ts
   const tx = await factory.createPool(manifest.tokens.ASSET, manifest.tokens.USDC);
   const receipt = await tx.wait();
   const poolAddr = receipt.logs.find(l => l.fragment?.name === "PoolCreated")!.args.pool;
   console.log("New pool:", poolAddr);
   ```

3. Record `poolAddr` in `pool-manifest.json` (manual edit) so the rest of the tooling can read it. For the FAFE flow we only care about this single pool; no need to wire NEG/POS labels here.

> Using an existing pool is fine, but make sure its reserves are zeroed first. The instructions below assume a brand-new pool.

---

## Step 2 — Bootstrap `.000012` cbBTC at `-5000` bps

1. Convert the seed amounts once so we don’t fat-finger them later:
   ```ts
   const seedAsset = ethers.parseUnits("0.000012", 8); // = 1,200 sats
   const seedUsdc  = ethers.parseUnits("0.50", 6);     // any positive amount works; keep 0.50 USDC
   const offsetBps = -5000;                            // −5,000 bps = −50%
   ```
   > Treasury requires **both** assets to be non-zero, so even though we “don’t care” about USDC we still pass 0.50 to satisfy the guard.

2. Bootstrap from the treasury contract (only owner: `treasuryOps`):
   ```ts
   const treasury = await ethers.getContractAt("LPPTreasury", manifest.contracts.LPPTreasury, treasuryOps);
   await treasury["bootstrapViaTreasury(address,uint256,uint256,int256)"](poolAddr, seedAsset, seedUsdc, offsetBps);
   ```

3. Verify reserves straight from the live pool:
   ```ts
   const pool = await ethers.getContractAt("ILPPPool", poolAddr);
   console.log(await pool.reserveAsset()); // should be 1200
   console.log(await pool.reserveUsdc());  // should be 500000
   console.log(await pool.targetOffsetBps()); // should be -5000
   ```

4. Orbit registration is **optional for this task**. If `setDualOrbitViaTreasury` reverts because the router expects four pools, skip it; the single-pool `supplicate` path does not read orbit data.

---

## Step 3 — Approve MASS tester for single-pool access

1. Ensure `MASS_TESTER_ADDRESS` is whitelisted:
   ```ts
   const access = await ethers.getContractAt("LPPAccessManager", manifest.contracts.LPPAccessManager, treasuryOps);
   await access.setApprovedSupplicator(process.env.MASS_TESTER_ADDRESS, true);
   ```

2. MASS tester needs USDC allowance **directly on the pool** (the pool pulls funds during `supplicate`):
   ```ts
   const massTester = new ethers.Wallet(process.env.MASS_TESTER_KEY, ethers.provider);
   const usdc = await ethers.getContractAt("IERC20", manifest.tokens.USDC, massTester);
   const spend = ethers.parseUnits("0.50", 6);
   await usdc.approve(poolAddr, spend);
   ```

3. (Optional) Snapshot the pre-trade state for the guide:  
   ```
   npx hardhat run scripts/read-onchain-prices.ts --network base \
     > test/MEV/test/__snapshots__/fafe-pre-supplicate.snap.json
   ```

---

## Step 4 — Supplicate $0.50 USDC for all cbBTC

Everything below runs as `MASS_TESTER_KEY`, calling the **already deployed** router.

1. Quote the single-pool trade to confirm it will drain the pool:
   ```ts
   const router = await ethers.getContractAt("LPPRouter", manifest.contracts.LPPRouter, massTester);
   const params = {
     pool: poolAddr,
     assetToUsdc: false,             // USDC in → ASSET out
     amountIn: ethers.parseUnits("0.50", 6),
     minAmountOut: 0n,
     payer: process.env.MASS_TESTER_ADDRESS,
     to: process.env.MASS_TESTER_ADDRESS,
   };
   const preview = await router.supplicate.staticCall(params);
   console.log("Expected cbBTC out:", preview.toString()); // should read ~1200 (all asset)
   ```

2. Execute the `supplicate`:
   ```ts
   const tx = await router.supplicate(params);
   await tx.wait();
   console.log("Supplicate tx:", tx.hash);
   ```
   - Events to watch: `HopExecuted` (router), `SupplicateExecuted` (router), and `Supplicate` (pool).
   - Because this is a single pool, offsets do **not** flip—only multi-hop swaps do that.

3. Confirm every cbBTC sat left the pool:
   ```ts
   console.log("asset reserve", await pool.reserveAsset()); // should be 0
   console.log("usdc reserve", await pool.reserveUsdc());   // should be 500000 + 500000 = 1,000,000 after USDC inflow
   ```

4. Snapshot the post-trade state to `test/MEV/test/__snapshots__/fafe-post-supplicate.snap.json` using the same `read-onchain-prices.ts` helper (or a direct JSON dump of reserves + balances). Reference both files from this guide so we can compare pre/post when reviewing.

---

## Checklist recap

- [ ] Factory + treasury confirmed live (no redeploys).
- [ ] New pool created and recorded.
- [ ] Pool bootstrapped with `0.000012` cbBTC at `-5000` bps (USDC amount arbitrary but >0).
- [ ] MASS tester approved + USDC allowance granted.
- [ ] Static quote shows ~1200 sats out for 0.50 USDC in.
- [ ] On-chain `supplicate` drains cbBTC balance.
- [ ] Before/after snapshots stored under `test/MEV/test/__snapshots__/`.

Follow this exactly to keep the FAFE flow constrained to the live Base contracts. Update the numbers only if treasury balances or offsets change again.
