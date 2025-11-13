# LPP + Flashbots Searcher (Using **Real** Contract ABIs Only)

This guide wires your **LPP Pool + Router + Rebate Vault** into a **Flashbots-style bundle searcher**, using **only the real ABIs compiled from your Solidity code** – no manually typed ABI fragments.

We’ll:

1. Clone the Flashbots bundle provider repo  
2. Copy / link your compiled LPP artifacts into that repo  
3. Configure TypeScript to import JSON artifacts  
4. Write an `lpp-searcher.ts` script that:
   - Uses `LPPPool`, `LPPSupplicationQuoter`, and `IERC20` ABIs from artifacts
   - Simulates LPP supplications off-chain
   - Computes LPP rebates/retentions (same math as `LPPMintHook`)
   - (Optionally) wraps a real Flashbots bundle around the trade

---

## 0. Assumptions

- Your **Infrastructure** repo already exists and compiles:
  - Contains `LPPPool.sol`, `LPPSupplicationQuoter.sol`, `IERC20.sol`, etc.
  - You can run: `yarn hardhat compile` there.
- You’re now working inside a **separate** repo cloned from Flashbots:
  - `ethers-provider-flashbots-bundle`
- Node 18+, `git`, and `yarn` or `npm` installed.

We will **not** hand-write ABIs. Everything comes from the `.json` artifact ABIs.

---

## 1. Clone the Flashbots Bundle Provider Repo

From wherever you want to keep the MEV searcher:

```bash
git clone https://github.com/flashbots/ethers-provider-flashbots-bundle.git
cd ethers-provider-flashbots-bundle
yarn install   # or: npm install
```

This repo will hold your **searcher** code.

---

## 2. Compile LPP Contracts & Copy Artifacts

In your **Infrastructure** repo (the one you pasted tests from), run:

```bash
cd /path/to/Infrastructure
yarn hardhat compile
```

You should now have artifacts like:

- `artifacts/contracts/LPPPool.sol/LPPPool.json`
- `artifacts/contracts/LPPSupplicationQuoter.sol/LPPSupplicationQuoter.json`
- `artifacts/contracts/external/IERC20.sol/IERC20.json`

Now copy those artifacts into the Flashbots repo. One simple approach:

```bash
# From your Infrastructure repo
cd /path/to/Infrastructure

# Create a tar of just the needed artifacts
tar czf lpp-artifacts.tgz   artifacts/contracts/LPPPool.sol/LPPPool.json   artifacts/contracts/LPPSupplicationQuoter.sol/LPPSupplicationQuoter.json   artifacts/contracts/external/IERC20.sol/IERC20.json

# Move it into the Flashbots repo
mv lpp-artifacts.tgz /path/to/ethers-provider-flashbots-bundle/

# In the Flashbots repo, unpack into ./artifacts
cd /path/to/ethers-provider-flashbots-bundle
mkdir -p artifacts/contracts/LPPPool.sol
mkdir -p artifacts/contracts/LPPSupplicationQuoter.sol
mkdir -p artifacts/contracts/external

tar xzf lpp-artifacts.tgz
```

After this, in the Flashbots repo you should have:

```text
artifacts/contracts/LPPPool.sol/LPPPool.json
artifacts/contracts/LPPSupplicationQuoter.sol/LPPSupplicationQuoter.json
artifacts/contracts/external/IERC20.sol/IERC20.json
```

These JSONs contain the **real ABIs** we’ll import.

---

## 3. Enable JSON Artifact Imports in TypeScript

Inside `ethers-provider-flashbots-bundle`, create / edit `tsconfig.json` (or merge into existing):

```jsonc
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "strict": false,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

Install TS + ts-node if not already there:

```bash
yarn add -D typescript ts-node @types/node
npx tsc --init  # if tsconfig didn't exist
```

Now TypeScript can do:

```ts
import LPPPoolArtifact from "../artifacts/contracts/LPPPool.sol/LPPPool.json";
```

and use `LPPPoolArtifact.abi` as the ABI source.

---

## 4. Add Environment Variables

In the Flashbots repo root:

```bash
touch .env
```

Fill in:

```ini
ETH_RPC_URL=http://127.0.0.1:8545

SEARCHER_PRIVATE_KEY=0xYOUR_SEARCHER_KEY
FLASHBOTS_SIGNING_KEY=0xYOUR_RELAY_SIGNING_KEY  # optional, can reuse searcher

LPP_POOL_ADDRESS=0xPoolAddressOnChain
LPP_SUPPLICATION_QUOTER_ADDRESS=0xQuoterAddressOnChain
ASSET_TOKEN_ADDRESS=0xAssetTokenAddress
USDC_TOKEN_ADDRESS=0xUsdcTokenAddress
```

> For early testing you don’t need real Flashbots relay calls; we can simulate bundles only, or even skip bundles and just simulate PnL off-chain.

---

## 5. Create the LPP-Aware Searcher Script (Using Artifacts Only)

Create a folder and script:

```bash
mkdir -p src/lpp
touch src/lpp/lpp-searcher.ts
```

Paste this in:

```ts
// src/lpp/lpp-searcher.ts
import "dotenv/config";
import { ethers } from "ethers";
import {
  FlashbotsBundleProvider,
  FlashbotsBundleRawTransaction,
} from "@flashbots/ethers-provider-flashbots-bundle";

// ✅ REAL ABIs – imported from compiled artifacts (no manual ABI typing)
import LPPPoolArtifact from "../../artifacts/contracts/LPPPool.sol/LPPPool.json";
import LPPSupplicationQuoterArtifact from "../../artifacts/contracts/LPPSupplicationQuoter.sol/LPPSupplicationQuoter.json";
import IERC20Artifact from "../../artifacts/contracts/external/IERC20.sol/IERC20.json";

type JsonArtifact = {
  abi: any;
};

const LPPPoolAbi = (LPPPoolArtifact as JsonArtifact).abi;
const LPPSupplicationQuoterAbi = (LPPSupplicationQuoterArtifact as JsonArtifact).abi;
const IERC20Abi = (IERC20Artifact as JsonArtifact).abi;

// ─────────────────────────────────────────────────────────────
// 1. Load ENV + base wiring
// ─────────────────────────────────────────────────────────────

const env = process.env as Record<string, string | undefined>;

const ETH_RPC_URL = env.ETH_RPC_URL!;
const SEARCHER_PRIVATE_KEY = env.SEARCHER_PRIVATE_KEY!;
const FLASHBOTS_SIGNING_KEY = env.FLASHBOTS_SIGNING_KEY || SEARCHER_PRIVATE_KEY;

const LPP_POOL_ADDRESS = env.LPP_POOL_ADDRESS!;
const LPP_SUPPLICATION_QUOTER_ADDRESS = env.LPP_SUPPLICATION_QUOTER_ADDRESS;
const ASSET_TOKEN_ADDRESS = env.ASSET_TOKEN_ADDRESS!;
const USDC_TOKEN_ADDRESS = env.USDC_TOKEN_ADDRESS!;

if (!ETH_RPC_URL || !SEARCHER_PRIVATE_KEY || !LPP_POOL_ADDRESS) {
  throw new Error("Missing required env vars (ETH_RPC_URL, SEARCHER_PRIVATE_KEY, LPP_POOL_ADDRESS, etc.)");
}

const provider = new ethers.JsonRpcProvider(ETH_RPC_URL);
const searcherWallet = new ethers.Wallet(SEARCHER_PRIVATE_KEY, provider);
const relaySigningWallet = new ethers.Wallet(FLASHBOTS_SIGNING_KEY!, provider);

// On-chain contracts driven purely by artifact ABIs:
const pool = new ethers.Contract(LPP_POOL_ADDRESS, LPPPoolAbi, provider);

const quoter = LPP_SUPPLICATION_QUOTER_ADDRESS
  ? new ethers.Contract(LPP_SUPPLICATION_QUOTER_ADDRESS, LPPSupplicationQuoterAbi, provider)
  : null;

const asset = new ethers.Contract(ASSET_TOKEN_ADDRESS, IERC20Abi, provider);
const usdc  = new ethers.Contract(USDC_TOKEN_ADDRESS,  IERC20Abi, provider);

// ─────────────────────────────────────────────────────────────
// 2. Helpers (humanize + rebate math identical to LPPMintHook)
// ─────────────────────────────────────────────────────────────

function humanizeSeconds(sec: number) {
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  return `${days}d ${hours}h ${mins}m`;
}

type RebateResult = {
  tier: number;
  shareBps: number;
  rebateAsset: bigint;
  rebateUsdc: bigint;
  keepAsset: bigint;
  keepUsdc: bigint;
};

function computeRebateFromDeposit(
  reserveAsset: bigint,
  reserveUsdc: bigint,
  amountAsset: bigint,
  amountUsdc: bigint
): RebateResult {
  if (reserveAsset === 0n || reserveUsdc === 0n) {
    return { tier: 0, shareBps: 0, rebateAsset: 0n, rebateUsdc: 0n, keepAsset: 0n, keepUsdc: 0n };
  }

  // Matches LPPMintHook.mintWithRebate logic
  const price1e18 = (reserveUsdc * 10n ** 18n) / reserveAsset;
  const depositValueUsdc = (amountAsset * price1e18) / 10n ** 18n + amountUsdc;
  const poolTvlUsdc      = (reserveAsset * price1e18) / 10n ** 18n + reserveUsdc;
  const tvlAfter         = poolTvlUsdc + depositValueUsdc;
  const shareBps         = tvlAfter === 0n ? 0n : (depositValueUsdc * 10_000n) / tvlAfter;

  let rebateBps = 0n;
  let retentionBps = 0n;
  let tier = 0;

  if (shareBps >= 500n && shareBps < 1000n)       { tier = 1; rebateBps = 100n; retentionBps = 50n; }
  else if (shareBps >= 1000n && shareBps < 2000n) { tier = 2; rebateBps = 180n; retentionBps = 90n; }
  else if (shareBps >= 2000n && shareBps < 3500n) { tier = 3; rebateBps = 250n; retentionBps = 125n; }
  else if (shareBps >= 5000n)                     { tier = 4; rebateBps = 350n; retentionBps = 175n; }

  const rebateAsset = (amountAsset * rebateBps) / 10_000n;
  const rebateUsdc  = (amountUsdc  * rebateBps) / 10_000n;

  const keepAsset   = (amountAsset * retentionBps) / 10_000n;
  const keepUsdc    = (amountUsdc  * retentionBps) / 10_000n;

  return {
    tier,
    shareBps: Number(shareBps),
    rebateAsset,
    rebateUsdc,
    keepAsset,
    keepUsdc,
  };
}

// ─────────────────────────────────────────────────────────────
// 3. Off-chain supplication profitability simulation
// ─────────────────────────────────────────────────────────────

async function simulateSupplication(amountInAsset: bigint) {
  const [rA, rU] = await Promise.all([
    pool.reserveAsset() as Promise<bigint>,
    pool.reserveUsdc() as Promise<bigint>,
  ]);

  if (rA === 0n || rU === 0n) {
    console.log("Pool not initialized. Skipping.");
    return;
  }

  const decimalsAsset = await asset.decimals();
  const decimalsUsdc  = await usdc.decimals();

  const amountInHuman = Number(amountInAsset) / 10 ** decimalsAsset;

  let amountOut: bigint;
  let driftBps: bigint;

  if (quoter) {
    const quote = await quoter.quoteSupplication(LPP_POOL_ADDRESS, true, amountInAsset);
    amountOut = quote.expectedAmountOut as bigint;
    driftBps  = BigInt(quote.priceDriftBps);
  } else {
    const [out, drift] = await pool.quoteSupplication(true, amountInAsset);
    amountOut = out;
    driftBps  = BigInt(drift);
  }

  const amountOutHuman = Number(amountOut) / 10 ** decimalsUsdc;

  // crude edge: impliedPrice must beat 1.0 by some bps
  const impliedPrice = (amountOut * 10_000n) / amountInAsset; // USDC per asset, x1e4
  const edgeBps = 10n; // > 0.10% above 1x

  const profitable = amountOut > 0n && impliedPrice > 10_000n + edgeBps;

  console.log("──────────────────────────────── LPP Opportunity Check");
  console.log("Pool:", LPP_POOL_ADDRESS);
  console.log("Reserves: asset =", rA.toString(), "usdc =", rU.toString());
  console.log("Supplicate: asset → usdc");
  console.log(" amountIn:", amountInHuman, "(raw", amountInAsset.toString() + ")");
  console.log(" amountOut:", amountOutHuman, "(raw", amountOut.toString() + ")");
  console.log(" impliedPrice (x1e4):", impliedPrice.toString());
  console.log(" priceDriftBps:", driftBps.toString());
  console.log(" profitable? ", profitable ? "✅ YES" : "❌ NO");

  return { rA, rU, amountInAsset, amountOut, impliedPrice, profitable };
}

// ─────────────────────────────────────────────────────────────
// 4. Integrate rebate vault economics into a PnL view
// ─────────────────────────────────────────────────────────────

async function simulateMintWithRebate(amountAsset: bigint, amountUsdc: bigint) {
  const [rA, rU] = await Promise.all([
    pool.reserveAsset() as Promise<bigint>,
    pool.reserveUsdc() as Promise<bigint>,
  ]);

  const res = computeRebateFromDeposit(rA, rU, amountAsset, amountUsdc);

  console.log("────────────────────────────── LPP Mint + Rebate Simulation");
  console.log("Pool:", LPP_POOL_ADDRESS);
  console.log("Reserves: asset =", rA.toString(), "usdc =", rU.toString());
  console.log("Deposit: asset =", amountAsset.toString(), "usdc =", amountUsdc.toString());
  console.log("Share of TVL (bps):", res.shareBps);
  console.log("Tier:", res.tier);
  console.log("Rebate asset:", res.rebateAsset.toString());
  console.log("Rebate usdc:", res.rebateUsdc.toString());
  console.log("Treasury keep asset:", res.keepAsset.toString());
  console.log("Treasury keep usdc:", res.keepUsdc.toString());

  // Here you’d plug into a PnL engine:
  // PnL ≈ trading PnL + value(rebateAsset + rebateUsdc) - gas cost
}

// ─────────────────────────────────────────────────────────────
// 5. (Optional) Flashbots bundle scaffolding
// ─────────────────────────────────────────────────────────────

async function initFlashbotsProvider() {
  const fbProvider = await FlashbotsBundleProvider.create(
    provider,
    relaySigningWallet,
    "https://relay.flashbots.net",
    "mainnet" // network name (for Base you’d switch to an appropriate builder/relay)
  );
  return fbProvider;
}

async function buildAndSimulateBundle() {
  const fb = await initFlashbotsProvider();

  const blockNumber = await provider.getBlockNumber();
  const gasPrice = await provider.getGasPrice();

  // Placeholder tx – you will replace `data` with a real encoded call
  const tx: FlashbotsBundleRawTransaction = {
    transaction: {
      to: LPP_POOL_ADDRESS,
      data: "0x", // TODO: encode LPPRouter.supplicate(...) once ABI is wired
      gasPrice,
      gasLimit: 700_000,
    },
    signer: searcherWallet,
  };

  const bundle = [tx];
  const sim = await fb.simulate(bundle, blockNumber + 1);

  console.log("Flashbots simulation result:", sim);
}

// ─────────────────────────────────────────────────────────────
// 6. Main entry
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log("Searcher address:", await searcherWallet.getAddress());

  const decimalsAsset = await asset.decimals();
  const decimalsUsdc  = await usdc.decimals();

  // Example trade size: 0.1 asset
  const amountInAsset = ethers.parseUnits("0.1", decimalsAsset);
  const suppRes = await simulateSupplication(amountInAsset);
  if (!suppRes) return;

  // Example mint size: 1 asset + 1000 USDC
  const mintAmountAsset = ethers.parseUnits("1.0", decimalsAsset);
  const mintAmountUsdc  = ethers.parseUnits("1000", decimalsUsdc);
  await simulateMintWithRebate(mintAmountAsset, mintAmountUsdc);

  // Optional: run bundle simulation (commented in early dev)
  // await buildAndSimulateBundle();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

This script:

- Uses **only** `abi` fields from your compiled artifacts (no manual ABI arrays).
- Simulates:
  - LPP supplication profitability (asset → USDC)
  - Rebate + retention economics like your `LPPMintHook`
- Provides a Flashbots bundle skeleton you can fill in with a real `LPPRouter.supplicate(...)` call.

---

## 6. Wire Script Into `package.json`

In `ethers-provider-flashbots-bundle/package.json`:

```jsonc
{
  "scripts": {
    "lpp:searcher": "ts-node src/lpp/lpp-searcher.ts"
  }
}
```

Run it:

```bash
yarn lpp:searcher
```

You should see logs like:

```text
Searcher address: 0x...
──────────────────────────────── LPP Opportunity Check
Pool: 0xPool...
Reserves: asset = ... usdc = ...
Supplicate: asset → usdc
 amountIn: 0.1 (raw 100000000000000000)
 amountOut: 301.23 (raw 301230000)
 impliedPrice (x1e4): 30123000
 priceDriftBps: 42
 profitable?  ✅ YES

────────────────────────────── LPP Mint + Rebate Simulation
Pool: 0xPool...
Reserves: asset = ...
Deposit: asset = ... usdc = ...
Share of TVL (bps): ...
Tier: 3
Rebate asset: ...
Rebate usdc: ...
Treasury keep asset: ...
Treasury keep usdc: ...
```

From there you can:

- Replace the placeholder bundle tx `data` with a real encoded `LPPRouter.supplicate(...)` call (using its artifact ABI).  
- Point `ETH_RPC_URL` to a **Base fork** or live Base RPC.  
- Start comparing LPP paths vs Uniswap v3 to see when real MEV bots would choose your LPP pools.
