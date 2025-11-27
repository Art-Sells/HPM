# FAFE Base Mainnet Integration Guide

This runbook exercises the live FAFE contracts exactly as deployed in `deployment-manifest.json`. No redeploys or local forks; every command hits production infrastructure.

---

## 1. Deployment Facts & Environment

| Component | Address / Notes |
| --- | --- |
| FAFERouter | `0x6118FFE292EE599FE2b987FCE9668ea9EB5d7ea4` |
| FAFETreasury | `0xDb36276F3f8C07d31364784B8d012129aC300853` |
| FAFEFactory | `0xe2eAA7BA9095e983D273ED0734FA0AbEB7E5612c` |
| FAFEAccessManager | `0x84890da18F1FA8Ec7F063B5e530E873bc84Ed07B` |
| cbBTC (ASSET) | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` (8 decimals) |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals) |
| Treasury Ops signer | `0xd9a6714bba0985b279dfcaff0a512ba25f5a03d1` |
| MASS tester | `MASS_TESTER_ADDRESS` / `MASS_TESTER_KEY` |

Environment variables:

```
BASE_RPC_URL=...
TREASURY_OPS_KEY=...
MASS_TESTER_ADDRESS=...
MASS_TESTER_KEY=...
FAFE_ASSET_AMOUNT=0.000012
FAFE_USDC_AMOUNT=0.5
FAFE_SUPPLICATE_USDC=0.5
```

All Hardhat commands run from the FAFE directory with `--network base`.

---

## 2. Prepare Factory & Pick a Pool

1. Pull the manifest and factory handle:
   ```ts
   const manifest = require("../deployment-manifest.json");
   const factory = await ethers.getContractAt("FAFEFactory", manifest.contracts.FAFEFactory, treasuryOps);
   ```
2. Allow-list ASSET/USDC every session (idempotent):
   ```ts
   await factory.setAllowedToken(manifest.tokens.ASSET, true);
   await factory.setAllowedToken(manifest.tokens.USDC, true);
   ```
3. Create a fresh pool if needed:
   ```ts
   const tx = await factory.createPool(manifest.tokens.ASSET, manifest.tokens.USDC);
   const receipt = await tx.wait();
   const poolAddr = receipt.logs.find(l => l.fragment?.name === "PoolCreated")!.args.pool;
   ```
4. Record `poolAddr` inside `test/Deployment/pool-manifest.json` under the NEG orbit list.

> You can reuse an empty pool, but confirm both reserves are zero before continuing.

---

## 3. Bootstrap −5,000 bps Seed Liquidity

1. Translate CLI env to on-chain amounts:
   ```ts
   const seedAsset = ethers.parseUnits(process.env.FAFE_ASSET_AMOUNT ?? "0.000012", 8);
   const seedUsdc  = ethers.parseUnits(process.env.FAFE_USDC_AMOUNT ?? "0.5", 6);
   const offsetBps = -5000;
   ```
2. Bootstrap via treasury:
   ```ts
   const treasury = await ethers.getContractAt("FAFETreasury", manifest.contracts.FAFETreasury, treasuryOps);
   await treasury["bootstrapViaTreasury(address,uint256,uint256,int256)"](poolAddr, seedAsset, seedUsdc, offsetBps);
   ```
3. Verify reserves and offsets:
   ```ts
   const pool = await ethers.getContractAt("IFAFEPool", poolAddr);
   console.log(await pool.reserveAsset());
   console.log(await pool.reserveUsdc());
   console.log(await pool.targetOffsetBps());
   ```

Orbit registration is optional for single-pool testing; leave it unset if `setDualOrbit` reverts.

---

## 4. Approve & Fund the MASS Tester

1. Whitelist the tester:
   ```ts
   const access = await ethers.getContractAt("FAFEAccessManager", manifest.contracts.FAFEAccessManager, treasuryOps);
   await access.setApprovedSupplicator(process.env.MASS_TESTER_ADDRESS, true);
   ```
2. Grant USDC allowance directly on the pool:
   ```ts
   const massTester = new ethers.Wallet(process.env.MASS_TESTER_KEY, ethers.provider);
   const usdc = await ethers.getContractAt("IERC20", manifest.tokens.USDC, massTester);
   await usdc.approve(poolAddr, ethers.parseUnits(process.env.FAFE_SUPPLICATE_USDC ?? "0.5", 6));
   ```
3. Snapshot the pre-trade state for regression evidence:
   ```bash
   npx hardhat run scripts/read-onchain-prices.ts --network base \
     > test/Deployment/__snapshots__/pre-supplicate.snap.json
   ```

---

## 6. Execute Supplicate & Capture Logs

1. Quote and execute the trade:
   ```ts
   const router = await ethers.getContractAt("FAFERouter", manifest.contracts.FAFERouter, massTester);
   const params = {
     pool: poolAddr,
     assetToUsdc: false,
     amountIn: ethers.parseUnits(process.env.FAFE_SUPPLICATE_USDC ?? "0.5", 6),
     minAmountOut: 0n,
     payer: process.env.MASS_TESTER_ADDRESS,
     to: process.env.MASS_TESTER_ADDRESS,
   };
   const preview = await router.supplicate.staticCall(params);
   console.log("Expected cbBTC out:", preview);
   const tx = await router.supplicate(params);
   await tx.wait();
   ```
2. Emit a post-trade snapshot:
   ```bash
   npx hardhat run scripts/read-onchain-prices.ts --network base \
     > test/Deployment/__snapshots__/post-supplicate.snap.json
   ```
3. Confirm reserves moved as expected (cbBTC drained, USDC doubled).

---

## 7. Checklist & Follow-ups

- [ ] Factory + treasury confirmed live.
- [ ] Pool created/recorded in `pool-manifest.json`.
- [ ] Seeded with `FAFE_ASSET_AMOUNT` / `FAFE_USDC_AMOUNT` at −5,000 bps.
- [ ] MASS tester whitelisted + allowance granted.
- [ ] Static call matches on-chain execution.
- [ ] Pre/post snapshots stored under `test/Deployment/__snapshots__/`.
- [ ] Logs archived (e.g., `logs/deploy-*.log`, transaction hashes noted).

Next steps:
- Repeat the flow for additional pools (build the full six-pool lattice).
- Introduce positive-orbit (+5,000 bps) bootstraps to test ASSET→USDC premiums.
- Plug the AI controller into these scripts to automate borrow–trade–rebalance cycles.
