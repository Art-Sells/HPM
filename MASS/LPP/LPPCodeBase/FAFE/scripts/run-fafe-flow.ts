import hre from "hardhat";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";

dotenv.config();

const { ethers } = hre;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SNAPSHOT_DIR = path.resolve(__dirname, "../test/Deployment/__snapshots__");
const PRE_SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, "fafe-pre-supplicate.snap.json");
const POST_SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, "fafe-post-supplicate.snap.json");

const manifestPath = path.resolve(__dirname, "../test/Deployment/deployment-manifest.json");
const poolManifestPath = path.resolve(__dirname, "../test/Deployment/pool-manifest.json");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const poolManifest = JSON.parse(fs.readFileSync(poolManifestPath, "utf8"));

const assetDecimals = 8;
const usdcDecimals = 6;

function formatUnits(value: bigint, decimals: number) {
  return Number(ethers.formatUnits(value, decimals));
}

function priceFromQ96(priceX96: bigint) {
  const ratio = Number(priceX96) / Math.pow(2, 96);
  const decimalAdjustment = Math.pow(10, assetDecimals) / Math.pow(10, usdcDecimals);
  return ratio * decimalAdjustment;
}

async function getPoolState(poolAddr: string) {
  const pool = await ethers.getContractAt("IFAFEPool", poolAddr);
  const [reserveAsset, reserveUsdc, targetOffsetBps, priceX96] = await Promise.all([
    pool.reserveAsset(),
    pool.reserveUsdc(),
    pool.targetOffsetBps(),
    pool.priceX96(),
  ]);

  return {
    address: poolAddr,
    targetOffsetBps: Number(targetOffsetBps),
    reserves: {
      ASSET: {
        raw: reserveAsset.toString(),
        formatted: formatUnits(reserveAsset, assetDecimals),
      },
      USDC: {
        raw: reserveUsdc.toString(),
        formatted: formatUnits(reserveUsdc, usdcDecimals),
      },
    },
    priceX96: priceX96.toString(),
    price: priceFromQ96(priceX96).toFixed(2),
  };
}

async function writeSnapshot(filePath: string, data: unknown) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function main() {
  const provider = ethers.provider;

  const treasuryOpsKey = process.env.TREASURY_OPS_KEY || process.env.PRIVATE_KEY;
  const massTesterKey = process.env.MASS_TESTER_KEY;
  const massTesterAddress = process.env.MASS_TESTER_ADDRESS;

  if (!treasuryOpsKey) throw new Error("TREASURY_OPS_KEY missing");
  if (!massTesterKey) throw new Error("MASS_TESTER_KEY missing");
  if (!massTesterAddress) throw new Error("MASS_TESTER_ADDRESS missing");

  const treasuryOps = new ethers.Wallet(treasuryOpsKey, provider);
  const massTester = new ethers.Wallet(massTesterKey, provider);

  console.log("TREASURY OPS:", treasuryOps.address);
  console.log("MASS TESTER:", massTester.address);

  if (massTester.address.toLowerCase() !== massTesterAddress.toLowerCase()) {
    throw new Error("MASS_TESTER_ADDRESS mismatch with MASS_TESTER_KEY");
  }

  const factory = await ethers.getContractAt("FAFEFactory", manifest.contracts.FAFEFactory);

  const access = await ethers.getContractAt(
    "FAFEAccessManager",
    manifest.contracts.FAFEAccessManager,
    treasuryOps
  );

  const treasury = await ethers.getContractAt(
    "FAFETreasury",
    manifest.contracts.FAFETreasury,
    treasuryOps
  );

  const router = await ethers.getContractAt(
    "FAFERouter",
    manifest.contracts.FAFERouter,
    massTester
  );

  const usdcToken = await ethers.getContractAt("IERC20", manifest.tokens.USDC, massTester);
  const assetToken = await ethers.getContractAt("IERC20", manifest.tokens.ASSET, massTester);

  console.log("\n== Step 1: Ensure tokens allowed and source pool ==");

  console.log("Allow-listing cbBTC on factory via treasury...");
  const allowAssetTx = await treasury.allowTokenViaTreasury(
    manifest.contracts.FAFEFactory,
    manifest.tokens.ASSET,
    true
  );
  console.log("  cbBTC tx hash:", allowAssetTx.hash);
  await allowAssetTx.wait();
  console.log("  cbBTC allow confirmed.");

  console.log("Allow-listing USDC on factory via treasury...");
  const allowUsdcTx = await treasury.allowTokenViaTreasury(
    manifest.contracts.FAFEFactory,
    manifest.tokens.USDC,
    true
  );
  console.log("  USDC tx hash:", allowUsdcTx.hash);
  await allowUsdcTx.wait();
  console.log("  USDC allow confirmed.");

  console.log("Tokens confirmed on factory allow list via Treasury.");

  let poolAddr = process.env.FAFE_POOL_ADDRESS || "";

  if (poolAddr) {
    console.log("Using existing pool:", poolAddr);
  } else {
    const createTx = await treasury.createPoolViaTreasury(
      manifest.contracts.FAFEFactory,
      manifest.tokens.ASSET,
      manifest.tokens.USDC
    );
    const createRcpt = await createTx.wait();

    for (const log of createRcpt.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed?.name === "PoolCreated") {
          poolAddr = parsed.args.pool;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!poolAddr) {
      throw new Error("Failed to parse PoolCreated event");
    }

    console.log("New pool:", poolAddr);
  }

  const seedAssetStr = process.env.FAFE_ASSET_AMOUNT || "0.000012";
  const seedUsdcStr = process.env.FAFE_USDC_AMOUNT || "0.50";
  const suppUsdcStr = process.env.FAFE_SUPPLICATE_USDC || "0.50";
  const offsetBps = process.env.FAFE_OFFSET_BPS
    ? Number(process.env.FAFE_OFFSET_BPS)
    : -5000;

  console.log(
    `\n== Step 2: Bootstrap pool with ${seedAssetStr} cbBTC @ ${offsetBps} bps (USDC ${seedUsdcStr}) ==`
  );
  const seedAsset = ethers.parseUnits(seedAssetStr, assetDecimals);
  const seedUsdc = ethers.parseUnits(seedUsdcStr, usdcDecimals);
  const suppUsdc = ethers.parseUnits(suppUsdcStr, usdcDecimals);

  const treasuryAddr = manifest.contracts.FAFETreasury;
  const treasuryAssetBal = await assetToken.balanceOf(treasuryAddr);
  const treasuryUsdcBal = await usdcToken.balanceOf(treasuryAddr);

  if (treasuryAssetBal < seedAsset) {
    throw new Error(
      `Treasury cbBTC balance ${ethers.formatUnits(
        treasuryAssetBal,
        assetDecimals
      )} is below required ${ethers.formatUnits(seedAsset, assetDecimals)}`
    );
  }

  if (treasuryUsdcBal < seedUsdc) {
    throw new Error(
      `Treasury USDC balance ${ethers.formatUnits(
        treasuryUsdcBal,
        usdcDecimals
      )} is below required ${ethers.formatUnits(seedUsdc, usdcDecimals)}`
    );
  }

  const bootstrapTx = await treasury[
    "bootstrapViaTreasury(address,uint256,uint256,int256)"
  ](poolAddr, seedAsset, seedUsdc, offsetBps);
  await bootstrapTx.wait();
  console.log("Bootstrap complete.");

  const poolStateBefore = await getPoolState(poolAddr);

  const poolKey = `fafePool-${Date.now()}`;
  poolManifest.pools[poolKey] = {
    address: poolAddr,
    orbit: "FAFE",
    offset: offsetBps,
    initialized: true,
    reserves: {
      ASSET: {
        raw: seedAsset.toString(),
        formatted: seedAssetStr,
      },
      USDC: {
        raw: seedUsdc.toString(),
        formatted: seedUsdcStr,
      },
    },
    priceX96: poolStateBefore.priceX96,
    price: poolStateBefore.price,
    router: manifest.contracts.FAFERouter,
  };
  fs.writeFileSync(poolManifestPath, JSON.stringify(poolManifest, null, 2));

  console.log("\n== Step 3: Approve MASS tester & allowances ==");
  const approveSuppTx = await access.setApprovedSupplicator(massTester.address, true);
  await approveSuppTx.wait();
  console.log("MASS tester approved as supplicator.");

  const approveUsdcTx = await usdcToken.approve(poolAddr, suppUsdc);
  await approveUsdcTx.wait();
  console.log("Pool allowance granted for USDC.");

  const massTesterBalancesBefore = {
    usdc: formatUnits(await usdcToken.balanceOf(massTester.address), usdcDecimals),
    asset: formatUnits(await assetToken.balanceOf(massTester.address), assetDecimals),
  };

  await writeSnapshot(PRE_SNAPSHOT_PATH, {
    timestamp: new Date().toISOString(),
    pool: poolStateBefore,
    massTester: {
      address: massTester.address,
      balances: massTesterBalancesBefore,
    },
  });
  console.log("Pre-supplicate snapshot saved.");

  console.log(`\n== Step 4: Supplicate ${suppUsdcStr} USDC for cbBTC ==`);
  const suppParams = {
    pool: poolAddr,
    assetToUsdc: false,
    amountIn: suppUsdc,
    minAmountOut: 0n,
    to: massTester.address,
    payer: massTester.address,
  };

  const preview = await router.supplicate.staticCall(suppParams);
  console.log("Expected cbBTC out:", ethers.formatUnits(preview, assetDecimals), "cbBTC");

  const suppTx = await router.supplicate(suppParams);
  const suppRcpt = await suppTx.wait();
  console.log("Supplicate tx hash:", suppRcpt.hash);

  const poolStateAfter = await getPoolState(poolAddr);
  const massTesterBalancesAfter = {
    usdc: formatUnits(await usdcToken.balanceOf(massTester.address), usdcDecimals),
    asset: formatUnits(await assetToken.balanceOf(massTester.address), assetDecimals),
  };

  await writeSnapshot(POST_SNAPSHOT_PATH, {
    timestamp: new Date().toISOString(),
    pool: poolStateAfter,
    massTester: {
      address: massTester.address,
      balances: massTesterBalancesAfter,
    },
    tx: suppRcpt.hash,
  });
  console.log("Post-supplicate snapshot saved.");

  console.log("\nFAFE flow complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

