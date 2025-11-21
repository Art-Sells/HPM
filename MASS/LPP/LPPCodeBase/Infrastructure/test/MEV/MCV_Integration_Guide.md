# LPP Phase 0 — Step-by-Step Guide for MEV / Searcher Integration (On-Chain)

## 5A — On-Chain Deployment & Pool Bootstrapping


### 5A.1 Freeze Parameters

Create a config file containing:

- **Chain** (e.g., Base Mainnet)
- **Tokens**
  - USDC address
  - ASSET address
- **Treasury addresses**
  - treasuryOwner
  - treasuryOps
- **AccessManager + Router config**
  - Daily cap
  - `mcvFeeBps = 250` (2.5%)
  - `treasuryCutBps = 50` (0.5%)
- **Pool topology**
  - Reference price: 1 ASSET = 1 USDC
  - Offsets: −500, −499, +499, +500 bps
  - Seed TVL: 1 ASSET + 1 USDC

---

### 5A.2 Deploy Contracts

Deploy in this order:

1. `LPPAccessManager`
2. `LPPTreasury`
3. `LPPFactory`
4. `LPPRouter`

Example Hardhat script:

```ts
// scripts/deployPhase0.ts
import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();

  const AccessManager = await ethers.getContractFactory("LPPAccessManager");
  const accessManager = await AccessManager.deploy();
  await accessManager.waitForDeployment();

  const Treasury = await ethers.getContractFactory("LPPTreasury");
  const treasury = await Treasury.deploy(await accessManager.getAddress());
  await treasury.waitForDeployment();

  const Factory = await ethers.getContractFactory("LPPFactory");
  const factory = await Factory.deploy(await treasury.getAddress());
  await factory.waitForDeployment();

  const Router = await ethers.getContractFactory("LPPRouter");
  const router = await Router.deploy(
    await factory.getAddress(),
    await accessManager.getAddress(),
    await treasury.getAddress()
  );
  await router.waitForDeployment();

  console.log("AccessManager:", await accessManager.getAddress());
  console.log("Treasury:", await treasury.getAddress());
  console.log("Factory:", await factory.getAddress());
  console.log("Router:", await router.getAddress());
}

main().catch(console.error);
```

---

### 5A.3 Wire Permissions

From `treasuryOwner`:

```solidity
accessManager.setApprovedSupplicator(treasuryOps, true);
```

Set pausers/admins if required.

---

### 5A.4 Create the 4 Pools

Using:

```solidity
factory.createPool(asset, usdc, offsetBps);
```

Create:

- Pool A: −500 bps  
- Pool B: −499 bps  
- Pool C: +499 bps  
- Pool D: +500 bps  

Store addresses in config.

---

### 5A.5 Bootstrap Reserves & Prices

From `treasuryOps`:

- Approve pools or Router to pull assets
- Call:

```solidity
bootstrapInitialize(
  reserveAsset,
  reserveUsdc,
  priceX96Offset
);
```

Seed each pool with **1 ASSET + 1 USDC**.

---

### 5A.6 Live Smoke Tests

Perform tiny swaps:

1. **supplicate** on Pool B: USDC → ASSET  
2. **mcvSupplication** on B → C → D  
3. Validate:
   - Profit detection  
   - 2.5% fee  
   - Treasury receives 0.5%  
   - Events are correct  

---

## 5B — Searcher Surface (View Methods, Events, Indexer)

### 5B.1 Router View Functions (Bot-Facing)

Add these:

- `getPoolState(pool)`  
- `quoteSupplication(pool, direction, amountIn)`  
- `quoteMCVOrbit(pools[], direction, amountIn)`  
- `buildMCVCalldata(...)` (MEV bundle builder)  
- `mcvSupplicationAndCallback(...)` (MEV callback entrypoint)  
- `minTotalAmountOut` for slippage enforcement  

---

### 5B.2 Slippage Guard

`mcvSupplication` must revert if:

```solidity
amountOut < minTotalAmountOut
```

Emit `SlippageExceeded()`.

---

### 5B.3 Events for Indexers

Emit:

```solidity
event Supplicate(...);
event MCVSupplicationExecuted(...);
```

Custom errors:

- `MaxDailyEventsReached()`
- `OrbitNotSet()`
- `SlippageExceeded()`

---

### 5B.4 Indexer / Subgraph

Entities:

- `Pool`
- `MCVOrbit`
- `MCVEvent`

Track:

- Price changes  
- TVL  
- MCV execution frequency  
- Profitability  

Searchers can query this or operate purely off RPC.

---

## 5C — MEV External Trials

1. Publish SDK with:
   - `quoteAndBuildBundle(startPool, amountIn)`
   - Example scripts  
   - Contract addresses  
2. Announce availability  
3. Monitor:
   - Frequency  
   - Profit  
   - Treasury growth  
   - Pool drift  
   - Adjust bps fees if needed (low or high)


