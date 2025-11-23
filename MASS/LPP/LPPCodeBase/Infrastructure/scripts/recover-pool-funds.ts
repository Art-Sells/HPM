// scripts/recover-pool-funds.ts
// Check pool state and attempt to recover funds if orbits aren't set
//
// Usage:
//   npx hardhat run scripts/recover-pool-funds.ts --network base

import hre from "hardhat";
const { ethers } = hre;
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
dotenv.config();

async function main() {
  const provider = ethers.provider;
  const deployerPk = process.env.PRIVATE_KEY_DEPLOYER || process.env.PRIVATE_KEY;
  if (!deployerPk) {
    throw new Error("Set PRIVATE_KEY_DEPLOYER or PRIVATE_KEY in .env");
  }
  const deployer = new ethers.Wallet(deployerPk, provider);

  console.log("Recovering pool funds...\n");

  // Load deployment manifest
  const manifestPath = path.join(process.cwd(), "deployment-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("deployment-manifest.json not found");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

  const treasuryAddr = manifest.contracts.LPPTreasury;
  const factoryAddr = manifest.contracts.LPPFactory;
  const routerAddr = manifest.contracts.LPPRouter;
  const assetAddr = manifest.tokens.ASSET;
  const usdcAddr = manifest.tokens.USDC;

  const TreasuryFactory = await ethers.getContractFactory("LPPTreasury");
  const FactoryFactory = await ethers.getContractFactory("LPPFactory");
  const RouterFactory = await ethers.getContractFactory("LPPRouter");
  const PoolFactory = await ethers.getContractFactory("LPPPool");
  const AssetFactory = await ethers.getContractFactory("TestERC20");

  const treasury = TreasuryFactory.attach(treasuryAddr).connect(deployer);
  const factory = FactoryFactory.attach(factoryAddr).connect(provider);
  const router = RouterFactory.attach(routerAddr).connect(provider);
  
  // Use ERC20 ABI to read decimals
  const erc20Abi = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
  ];
  const asset = new ethers.Contract(assetAddr, erc20Abi, provider);
  const usdc = new ethers.Contract(usdcAddr, erc20Abi, provider);

  const assetDecimals = await asset.decimals();
  const usdcDecimals = await usdc.decimals();

  // Only check bootstrapped pools from previous run or manifest
  const bootstrappedPools: string[] = [];
  
  // First, check manifest for pools
  if (manifest.pools) {
    const manifestPools = [
      manifest.pools.pool0?.address,
      manifest.pools.pool1?.address,
      manifest.pools.pool2?.address,
      manifest.pools.pool3?.address,
    ].filter(Boolean) as string[];
    if (manifestPools.length === 4) {
      console.log("Using pools from manifest\n");
      bootstrappedPools.push(...manifestPools);
    }
  }
  
  // If no manifest pools, use the known bootstrapped pools from previous run
  if (bootstrappedPools.length === 0) {
    bootstrappedPools.push(
      "0xb5889070070C9A666bd411E4D882e3E545f74aE0", // Pool0
      "0xa6c62A4edf110703f69505Ea8fAD940aDc6EAF9D", // Pool1
      "0x439634467E0322759b1a7369a552204ea42A3463", // Pool2
      "0xB1a5D1943612BbEE35ee7720f3a4bba74Fdc68b7", // Pool3
    );
  }
  
  console.log(`Checking ${bootstrappedPools.length} bootstrapped pools:\n`);

  const poolsToRecover: string[] = [];

  for (let i = 0; i < bootstrappedPools.length; i++) {
    const poolAddr = bootstrappedPools[i];
    const pool = PoolFactory.attach(poolAddr).connect(provider);
    
    try {
      const isInitialized = await pool.initialized();
      const reserveAsset = await pool.reserveAsset();
      const reserveUsdc = await pool.reserveUsdc();
      const targetOffsetBps = await pool.targetOffsetBps();
      
      // Check if orbit is registered for this pool
      let orbitRegistered = false;
      try {
        const dualOrbit = await router.getDualOrbit(poolAddr);
        orbitRegistered = dualOrbit[2] === true; // initialized flag
      } catch {
        orbitRegistered = false;
      }

      const hasFunds = reserveAsset > 0n || reserveUsdc > 0n;
      const needsRecovery = hasFunds && (!orbitRegistered || !isInitialized);

      console.log(`Bootstrapped Pool${i} (${poolAddr}):`);
      console.log(`  Initialized: ${isInitialized}`);
      console.log(`  Offset: ${targetOffsetBps} bps`);
      console.log(`  Orbit registered: ${orbitRegistered}`);
      console.log(`  Reserves: ${ethers.formatUnits(reserveAsset, assetDecimals)} ASSET, ${ethers.formatUnits(reserveUsdc, usdcDecimals)} USDC`);
      
      if (needsRecovery) {
        console.log(`  ⚠ NEEDS RECOVERY: Has funds but orbit not registered or not initialized`);
        poolsToRecover.push(poolAddr);
      } else if (hasFunds) {
        console.log(`  ✓ OK: Has funds and orbit is registered`);
      } else {
        console.log(`  - Empty pool`);
      }
      console.log();
    } catch (error: any) {
      console.log(`  ❌ Error checking pool: ${error.message}\n`);
    }
  }

  if (poolsToRecover.length > 0) {
    console.log(`\n⚠ WARNING: ${poolsToRecover.length} pools need recovery but pools don't have a withdraw function.`);
    console.log(`Funds are locked in pool reserves. You would need to use swaps to recover them.`);
    console.log(`Pool addresses:`, poolsToRecover);
  } else {
    console.log(`\n✓ All pools are properly configured or empty.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

