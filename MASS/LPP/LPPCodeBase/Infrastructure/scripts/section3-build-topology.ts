// scripts/section3-build-topology.ts
// Section 3: Build the Four-Pool Topology
// From MCV_Integration_Guide.md
//
// Usage:
//   npx hardhat run scripts/section3-build-topology.ts --network base
//
// Environment variables required:
//   - PRIVATE_KEY_DEPLOYER or PRIVATE_KEY: Private key of the treasury owner/ops account
//   - BASE_RPC_URL (optional): Override Base mainnet RPC URL

import hre from "hardhat";
const { ethers } = hre;
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
dotenv.config();

async function main() {
  // Try using Base public RPC if BASE_RPC_URL is not set, for better error messages
  let provider = ethers.provider;
  if (!process.env.BASE_RPC_URL) {
    console.log("⚠ Using default RPC. For better error messages, set BASE_RPC_URL in .env");
    console.log("   Example: BASE_RPC_URL=https://mainnet.base.org");
  }
  provider = ethers.provider;

  // Load deployer private key from environment
  const deployerPk = process.env.PRIVATE_KEY_DEPLOYER || process.env.PRIVATE_KEY;
  if (!deployerPk) {
    throw new Error("Set PRIVATE_KEY_DEPLOYER or PRIVATE_KEY in .env");
  }
  
  const deployer = new ethers.Wallet(deployerPk, provider);

  console.log("Executing from:", await deployer.getAddress());
  console.log("Network:", (await provider.getNetwork()).name);
  console.log("Chain ID:", (await provider.getNetwork()).chainId);

  // Load deployment manifest
  const manifestPath = path.join(process.cwd(), "deployment-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("deployment-manifest.json not found. Run Section 2 first.");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

  const treasuryAddr = manifest.contracts.LPPTreasury;
  const factoryAddr = manifest.contracts.LPPFactory;
  const routerAddr = manifest.contracts.LPPRouter;
  
  // Official Base mainnet token addresses (verified)
  const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Official Base USDC
  const BASE_CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"; // Coinbase Wrapped Bitcoin on Base
  
  // Use addresses from manifest, but fallback to known Base addresses if missing
  let assetAddr = manifest.tokens?.ASSET || BASE_CBBTC;
  let usdcAddr = manifest.tokens?.USDC || BASE_USDC;
  
  // Validate addresses match known Base mainnet addresses
  if (assetAddr.toLowerCase() !== BASE_CBBTC.toLowerCase()) {
    console.log(`   ⚠ WARNING: ASSET address ${assetAddr} does not match known Base cbBTC address ${BASE_CBBTC}`);
    console.log(`   Using known Base cbBTC address instead: ${BASE_CBBTC}`);
    assetAddr = BASE_CBBTC;
  }
  if (usdcAddr.toLowerCase() !== BASE_USDC.toLowerCase()) {
    console.log(`   ⚠ WARNING: USDC address ${usdcAddr} does not match known Base USDC address ${BASE_USDC}`);
    console.log(`   Using known Base USDC address instead: ${BASE_USDC}`);
    usdcAddr = BASE_USDC;
  }
  
  console.log(`   Verified ASSET (cbBTC): ${assetAddr}`);
  console.log(`   Verified USDC: ${usdcAddr}`);

  console.log("\n=== Section 3: Build the Four-Pool Topology ===\n");
  console.log("Treasury:", treasuryAddr);
  console.log("Factory:", factoryAddr);
  console.log("Router:", routerAddr);
  console.log("ASSET:", assetAddr);
  console.log("USDC:", usdcAddr);
  console.log("");

  // Get contract instances
  const TreasuryFactory = await ethers.getContractFactory("LPPTreasury");
  const treasury = TreasuryFactory.attach(treasuryAddr).connect(deployer);

  const FactoryFactory = await ethers.getContractFactory("LPPFactory");
  const factory = FactoryFactory.attach(factoryAddr).connect(deployer);

  const RouterFactory = await ethers.getContractFactory("LPPRouter");
  const router = RouterFactory.attach(routerAddr).connect(deployer);

  // Get token instances - use IERC20 interface for real tokens
  // Standard ERC20 interface: balanceOf(address), transfer(address,uint256), decimals(), etc.
  const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)",
  ];
  const asset = new ethers.Contract(assetAddr, ERC20_ABI, deployer);
  const usdc = new ethers.Contract(usdcAddr, ERC20_ABI, deployer);
  
  // Get token decimals
  const assetDecimals = await asset.decimals();
  const usdcDecimals = await usdc.decimals();
  console.log(`   ASSET decimals: ${assetDecimals}`);
  console.log(`   USDC decimals: ${usdcDecimals}`);

  // Step 0: Allowlist tokens in factory (required before creating pools)
  console.log("0. Allowlisting tokens in factory...");
  const assetAllowed = await factory.isTokenAllowed(assetAddr);
  const usdcAllowed = await factory.isTokenAllowed(usdcAddr);
  
  if (!assetAllowed) {
    const allowAssetTx = await treasury.allowTokenViaTreasury(factoryAddr, assetAddr, true, { gasLimit: 200000n });
    await allowAssetTx.wait();
    console.log("   ✓ ASSET allowlisted");
  } else {
    console.log("   ⏭ ASSET already allowlisted");
  }
  
  if (!usdcAllowed) {
    const allowUsdcTx = await treasury.allowTokenViaTreasury(factoryAddr, usdcAddr, true, { gasLimit: 200000n });
    await allowUsdcTx.wait();
    console.log("   ✓ USDC allowlisted");
  } else {
    console.log("   ⏭ USDC already allowlisted");
  }

  // Step 1: Check for existing pools or create new ones
  console.log("\n1. Checking existing infrastructure...");
  const pools: string[] = [];
  const PoolFactory = await ethers.getContractFactory("LPPPool");
  
  // 1a. List all pools from factory
  console.log("\n   1a. Checking factory for existing pools...");
  const allFactoryPools = await factory.getPools();
  console.log(`      Total pools in factory: ${allFactoryPools.length}`);
  
  // 1b. Check which pools are bootstrapped
  console.log("\n   1b. Checking bootstrapped pools...");
  const bootstrappedPools: string[] = [];
  
  for (const poolAddr of allFactoryPools) {
    try {
      const pool = PoolFactory.attach(poolAddr);
      const isInitialized = await pool.initialized();
      if (isInitialized) {
        bootstrappedPools.push(poolAddr);
      }
    } catch (error: any) {
      // Skip invalid pools
    }
  }
  
  console.log(`      Bootstrapped pools: ${bootstrappedPools.length}`);
  console.log(`      Uninitialized pools: ${allFactoryPools.length - bootstrappedPools.length}`);
  
  // 1c. Check treasury owner/operator balance
  console.log("\n   1c. Checking treasury owner/operator balances...");
  const treasuryOwner = await treasury.owner();
  const deployerAddr = await deployer.getAddress();
  console.log(`      Treasury owner: ${treasuryOwner}`);
  console.log(`      Deployer address: ${deployerAddr}`);
  
  const ownerAssetBal = await asset.balanceOf(treasuryOwner);
  const ownerUsdcBal = await usdc.balanceOf(treasuryOwner);
  const deployerAssetBal = await asset.balanceOf(deployerAddr);
  const deployerUsdcBal = await usdc.balanceOf(deployerAddr);
  
  console.log(`      Owner ASSET balance: ${ethers.formatUnits(ownerAssetBal, assetDecimals)}`);
  console.log(`      Owner USDC balance: ${ethers.formatUnits(ownerUsdcBal, usdcDecimals)}`);
  console.log(`      Deployer ASSET balance: ${ethers.formatUnits(deployerAssetBal, assetDecimals)}`);
  console.log(`      Deployer USDC balance: ${ethers.formatUnits(deployerUsdcBal, usdcDecimals)}`);
  
  // 1d. Check treasury contract balance
  console.log("\n   1d. Checking treasury contract balances...");
  console.log(`      Treasury contract: ${treasuryAddr}`);
  const treasuryAssetBal = await asset.balanceOf(treasuryAddr);
  const treasuryUsdcBal = await usdc.balanceOf(treasuryAddr);
  console.log(`      Treasury ASSET balance: ${ethers.formatUnits(treasuryAssetBal, assetDecimals)}`);
  console.log(`      Treasury USDC balance: ${ethers.formatUnits(treasuryUsdcBal, usdcDecimals)}`);
  
  // 1e. Check specific pools from previous run (if any)
  console.log("\n   1e. Checking pools from previous run...");
  const previousRunPools = [
    "0xAF007693E88a9fcC9904b3dB3cfa043A70CB3b8b", // Pool0 from bootstrap tx 0xaf52e973...
    "0xeA1F4410fA12CAa9b0a192b05825B42c5F752AA7", // Pool1 from bootstrap tx 0xaf52e973...
    "0x11f1D5363AaB6D90f4578Df237B7a6f905E6373C", // Pool2 from bootstrap tx 0xaf52e973...
    "0xE827b58175f0Ff97f03b98Bf1e9a2135C72B33D0", // Pool3 from bootstrap tx 0xaf52e973...
  ];
  
  let previousPoolsBootstrapped = 0;
  const validPreviousPools: string[] = [];
  for (const poolAddr of previousRunPools) {
    try {
      const pool = PoolFactory.attach(poolAddr).connect(deployer);
      const isPool = await factory.isPool(poolAddr);
      const isInitialized = await pool.initialized();
      if (isPool && isInitialized) {
        previousPoolsBootstrapped++;
        validPreviousPools.push(poolAddr);
        console.log(`      ✓ Previous Pool ${poolAddr} is bootstrapped`);
      } else if (isPool && !isInitialized) {
        console.log(`      ⚠ Previous Pool ${poolAddr} exists but NOT bootstrapped`);
      }
    } catch (error: any) {
      console.log(`      ⚠ Error checking previous pool ${poolAddr}: ${error.message}`);
    }
  }
  console.log(`      Previous run pools bootstrapped: ${previousPoolsBootstrapped}/4`);
  
  // If all 4 previous pools are valid and bootstrapped, use them
  if (validPreviousPools.length === 4) {
    console.log("      ✓ All previous pools are valid, will reuse them");
    pools.push(...validPreviousPools);
  }
  
  // 1f. Check manifest for pools (only if we don't already have pools from previous run)
  console.log("\n   1f. Checking deployment manifest...");
  const existingPools = manifest.pools;
  if (pools.length === 0 && existingPools && Object.keys(existingPools).length >= 4) {
    console.log("      Found pools in manifest, verifying they exist and are bootstrapped...");
    const candidatePools = [
      existingPools.pool0.address,
      existingPools.pool1.address,
      existingPools.pool2.address,
      existingPools.pool3.address,
    ];
    
    // Verify all pools exist, are registered in factory, and are bootstrapped
    let allValid = true;
    for (let i = 0; i < 4; i++) {
      try {
        const pool = PoolFactory.attach(candidatePools[i]);
        const isPool = await factory.isPool(candidatePools[i]);
        const isInitialized = await pool.initialized();
        
        if (!isPool) {
          console.log(`         ⚠ Pool${i} at ${candidatePools[i]} is not registered in factory`);
          allValid = false;
          break;
        }
        if (!isInitialized) {
          console.log(`         ⚠ Pool${i} at ${candidatePools[i]} exists but is not bootstrapped`);
          allValid = false;
          break;
        }
        console.log(`         ✓ Pool${i} verified and bootstrapped: ${candidatePools[i]}`);
      } catch (error: any) {
        console.log(`         ⚠ Pool${i} validation failed: ${error.message}`);
        allValid = false;
        break;
      }
    }
    
    if (allValid) {
      console.log("      ✓ All existing pools are valid and bootstrapped, reusing them");
      pools.push(...candidatePools);
    } else {
      console.log("      ⚠ Some pools are invalid, will create new ones");
    }
  } else {
    console.log("      No pools found in manifest");
  }
  
  // 1g. Decision: Create new pools if needed
  console.log("\n   1g. Decision: Reuse or create pools...");
  
  // Create new pools only if we don't have 4 valid bootstrapped pools
  if (pools.length < 4) {
    const poolsToCreate = 4 - pools.length;
    console.log(`      Need to create ${poolsToCreate} new pools...`);
    
    for (let i = 0; i < poolsToCreate; i++) {
      const tx = await treasury.createPoolViaTreasury(factoryAddr, assetAddr, usdcAddr);
      const receipt = await tx.wait();
      
      // Extract pool address from PoolCreated event
      const poolCreatedEvent = receipt?.logs.find((log: any) => {
        try {
          const parsed = factory.interface.parseLog(log);
          return parsed?.name === "PoolCreated";
        } catch {
          return false;
        }
      });
      
      if (!poolCreatedEvent) {
        throw new Error(`PoolCreated event not found for new pool ${i + 1}`);
      }
      
      const parsed = factory.interface.parseLog(poolCreatedEvent);
      const poolAddr = parsed?.args[0] as string;
      pools.push(poolAddr);
      console.log(`         ✓ New Pool${pools.length - 1} created at: ${poolAddr}`);
    }
  } else {
    console.log(`      ✓ Have ${pools.length} valid pools, no new pools needed`);
  }
  
  if (pools.length !== 4) {
    throw new Error(`Expected 4 pools, but have ${pools.length}`);
  }
  
  console.log("\n   Final pool list:");
  for (let i = 0; i < 4; i++) {
    console.log(`      Pool${i}: ${pools[i]}`);
  }

  // Step 2: Bootstrap pools with offsets AND set orbits atomically
  console.log("\n2. Bootstrapping pools and setting orbits (atomic operation)...");
  
  // Check which pools need bootstrapping
  const poolsAlreadyBootstrapped = await Promise.all(
    pools.map(async (poolAddr) => {
      const pool = PoolFactory.attach(poolAddr).connect(deployer);
      return await pool.initialized();
    })
  );
  
  const needBootstrap = poolsAlreadyBootstrapped.filter(b => b === false).length;
  
  if (needBootstrap === 0) {
    console.log("   ✓ All pools are already bootstrapped");
    
    // Check if orbits are set
    let allOrbitsSet = true;
    const negOrbit = [pools[0], pools[1]];
    const posOrbit = [pools[2], pools[3]];
    
    for (let i = 0; i < 4; i++) {
      try {
        const dualOrbit = await router.getDualOrbit(pools[i]);
        const existingNeg = dualOrbit[0] as string[];
        const existingPos = dualOrbit[1] as string[];
        if (existingNeg.length !== 2 || existingPos.length !== 2 ||
            existingNeg[0].toLowerCase() !== negOrbit[0].toLowerCase() ||
            existingNeg[1].toLowerCase() !== negOrbit[1].toLowerCase() ||
            existingPos[0].toLowerCase() !== posOrbit[0].toLowerCase() ||
            existingPos[1].toLowerCase() !== posOrbit[1].toLowerCase()) {
          allOrbitsSet = false;
          break;
        }
      } catch {
        allOrbitsSet = false;
        break;
      }
    }
    
    if (allOrbitsSet) {
      console.log("   ✓ All orbits are already set, skipping bootstrap step");
    } else {
      console.log("   ⚠ Pools are bootstrapped but orbits are not set");
      console.log("   ⚠ You may need to set orbits manually or re-run bootstrapTopology");
    }
  } else {
    console.log(`   ${needBootstrap} pools need bootstrapping...`);
    
    // Parse amounts using correct decimals
    // ASSET: 0.000006 (cbBTC has 8 decimals) - per MCV_Integration_Guide.md Section 1
    // USDC: 0.5 (USDC has 6 decimals) - per MCV_Integration_Guide.md Section 1
    const SEED_AMOUNT_ASSET = ethers.parseUnits("0.000006", assetDecimals);
    const SEED_AMOUNT_USDC = ethers.parseUnits("0.5", usdcDecimals);
    const requiredAsset = SEED_AMOUNT_ASSET * 4n; // Always need for all 4 pools
    const requiredUsdc = SEED_AMOUNT_USDC * 4n;

    // Ensure treasury contract has enough tokens
    console.log("   Checking balances...");
    const deployerAddr = await deployer.getAddress();
    console.log(`   Treasury contract: ${treasuryAddr}`);
    console.log(`   Deployer/owner: ${deployerAddr}`);
    
    const treasuryAssetBal = await asset.balanceOf(treasuryAddr);
    const treasuryUsdcBal = await usdc.balanceOf(treasuryAddr);
    const deployerAssetBal = await asset.balanceOf(deployerAddr);
    const deployerUsdcBal = await usdc.balanceOf(deployerAddr);
    
    console.log(`   Treasury contract ASSET: ${ethers.formatUnits(treasuryAssetBal, assetDecimals)}`);
    console.log(`   Treasury contract USDC: ${ethers.formatUnits(treasuryUsdcBal, usdcDecimals)}`);
    console.log(`   Deployer ASSET: ${ethers.formatUnits(deployerAssetBal, assetDecimals)}`);
    console.log(`   Deployer USDC: ${ethers.formatUnits(deployerUsdcBal, usdcDecimals)}`);
    
    // Transfer tokens from deployer to treasury contract if needed
    if (treasuryAssetBal < requiredAsset) {
      const needed = requiredAsset - treasuryAssetBal;
      if (deployerAssetBal >= needed) {
        console.log(`   Transferring ${ethers.formatUnits(needed, assetDecimals)} ASSET from deployer to treasury...`);
        const tx = await asset.transfer(treasuryAddr, needed);
        await tx.wait();
        console.log(`   ✓ ASSET transferred to treasury`);
      } else {
        throw new Error(`Insufficient ASSET. Deployer has ${ethers.formatUnits(deployerAssetBal, assetDecimals)}, but treasury needs ${ethers.formatUnits(needed, assetDecimals)} more`);
      }
    }
    
    if (treasuryUsdcBal < requiredUsdc) {
      const needed = requiredUsdc - treasuryUsdcBal;
      if (deployerUsdcBal >= needed) {
        console.log(`   Transferring ${ethers.formatUnits(needed, usdcDecimals)} USDC from deployer to treasury...`);
        const tx = await usdc.transfer(treasuryAddr, needed);
        await tx.wait();
        console.log(`   ✓ USDC transferred to treasury`);
      } else {
        throw new Error(`Insufficient USDC. Deployer has ${ethers.formatUnits(deployerUsdcBal, usdcDecimals)}, but treasury needs ${ethers.formatUnits(needed, usdcDecimals)} more`);
      }
    }
    
    // Verify treasury now has enough
    const finalTreasuryAssetBal = await asset.balanceOf(treasuryAddr);
    const finalTreasuryUsdcBal = await usdc.balanceOf(treasuryAddr);
    
    if (finalTreasuryAssetBal < requiredAsset) {
      throw new Error(`Treasury still has insufficient ASSET after transfer. Current: ${ethers.formatUnits(finalTreasuryAssetBal, assetDecimals)}, Required: ${ethers.formatUnits(requiredAsset, assetDecimals)}`);
    }
    if (finalTreasuryUsdcBal < requiredUsdc) {
      throw new Error(`Treasury still has insufficient USDC after transfer. Current: ${ethers.formatUnits(finalTreasuryUsdcBal, usdcDecimals)}, Required: ${ethers.formatUnits(requiredUsdc, usdcDecimals)}`);
    }
    
    console.log(`   ✓ Treasury has sufficient balances`);
    console.log(`   ASSET: ${ethers.formatUnits(finalTreasuryAssetBal, assetDecimals)} (required: ${ethers.formatUnits(requiredAsset, assetDecimals)})`);
    console.log(`   USDC: ${ethers.formatUnits(finalTreasuryUsdcBal, usdcDecimals)} (required: ${ethers.formatUnits(requiredUsdc, usdcDecimals)})`);

    // Use bootstrapTopology to bootstrap all 4 pools AND set orbits atomically
    console.log("\n   Calling bootstrapTopology (bootstraps 4 pools + sets orbits atomically)...");
    const poolsArray: [string, string, string, string] = [pools[0], pools[1], pools[2], pools[3]];
    const amountsAsset: [bigint, bigint, bigint, bigint] = [SEED_AMOUNT_ASSET, SEED_AMOUNT_ASSET, SEED_AMOUNT_ASSET, SEED_AMOUNT_ASSET];
    const amountsUsdc: [bigint, bigint, bigint, bigint] = [SEED_AMOUNT_USDC, SEED_AMOUNT_USDC, SEED_AMOUNT_USDC, SEED_AMOUNT_USDC];
    const offsetsBps: [bigint, bigint, bigint, bigint] = [-500n, -500n, 500n, 500n];
    const negOrbit = [pools[0], pools[1]];
    const posOrbit = [pools[2], pools[3]];
    
    try {
      const tx = await (treasury as any).bootstrapTopology(
        poolsArray,
        amountsAsset,
        amountsUsdc,
        offsetsBps,
        routerAddr,
        negOrbit,
        posOrbit
      );
      
      console.log(`   ✓ Transaction sent (tx: ${tx.hash})`);
      console.log(`   View on BaseScan: https://basescan.org/tx/${tx.hash}`);
      
      const receipt = await tx.wait();
      
      if (!receipt || receipt.status !== 1) {
        throw new Error(`Bootstrap topology transaction failed. Status: ${receipt?.status}`);
      }
      
      // Verify all pools are bootstrapped
      for (let i = 0; i < 4; i++) {
        const pool = PoolFactory.attach(pools[i]).connect(deployer);
        const isInitialized = await pool.initialized();
        if (!isInitialized) {
          throw new Error(`Pool${i} bootstrap succeeded but pool is not initialized`);
        }
        const offset = await pool.targetOffsetBps();
        const expectedOffset = i < 2 ? -500n : 500n;
        if (Number(offset) !== Number(expectedOffset)) {
          throw new Error(`Pool${i} has wrong offset: ${offset}, expected ${expectedOffset}`);
        }
      }
      
      // Verify orbits are set
      for (let i = 0; i < 4; i++) {
        const dualOrbit = await router.getDualOrbit(pools[i]);
        const existingNeg = dualOrbit[0] as string[];
        const existingPos = dualOrbit[1] as string[];
        if (existingNeg.length !== 2 || existingPos.length !== 2 ||
            existingNeg[0].toLowerCase() !== negOrbit[0].toLowerCase() ||
            existingNeg[1].toLowerCase() !== negOrbit[1].toLowerCase() ||
            existingPos[0].toLowerCase() !== posOrbit[0].toLowerCase() ||
            existingPos[1].toLowerCase() !== posOrbit[1].toLowerCase()) {
          throw new Error(`Pool${i} orbit not set correctly`);
        }
      }
      
      console.log(`   ✓ All 4 pools bootstrapped with correct offsets`);
      console.log(`   ✓ Dual orbits registered for all pools`);
      console.log(`   ✓ NEG orbit: ${negOrbit.join(", ")}`);
      console.log(`   ✓ POS orbit: ${posOrbit.join(", ")}`);
    } catch (error: any) {
      console.error(`   ❌ Failed to bootstrap topology:`, error.message);
      if (error.reason) {
        console.error(`   Revert reason:`, error.reason);
      }
      throw error;
    }
  }

  // Step 3: Create pool manifest with detailed information
  console.log("\n3. Creating pool manifest...");
  
  const poolManifest: any = {
    pools: {},
    tokens: {
      ASSET: {
        address: assetAddr,
        symbol: "cbBTC",
        decimals: assetDecimals,
      },
      USDC: {
        address: usdcAddr,
        symbol: "USDC",
        decimals: usdcDecimals,
      },
    },
    topology: {
      negOrbit: [pools[0], pools[1]],
      posOrbit: [pools[2], pools[3]],
      registeredUnder: pools,
    },
    createdAt: new Date().toISOString(),
  };
  
  // Get detailed information for each pool
  for (let i = 0; i < 4; i++) {
    const pool = PoolFactory.attach(pools[i]).connect(deployer);
    const isInitialized = await pool.initialized();
    const reserveAsset = await pool.reserveAsset();
    const reserveUsdc = await pool.reserveUsdc();
    const targetOffsetBps = await pool.targetOffsetBps();
    const poolRouterAddr = await pool.router();
    const priceX96 = await pool.priceX96();
    
    // Calculate price in human-readable format
    // priceX96 is in Q96 format: price = (priceX96 / 2^96)
    const price = Number(priceX96) / Math.pow(2, 96);
    
    poolManifest.pools[`pool${i}`] = {
      address: pools[i],
      orbit: i < 2 ? "NEG" : "POS",
      offset: Number(targetOffsetBps),
      initialized: isInitialized,
      reserves: {
        ASSET: {
          raw: reserveAsset.toString(),
          formatted: ethers.formatUnits(reserveAsset, assetDecimals),
        },
        USDC: {
          raw: reserveUsdc.toString(),
          formatted: ethers.formatUnits(reserveUsdc, usdcDecimals),
        },
      },
      priceX96: priceX96.toString(),
      price: price.toString(),
      router: poolRouterAddr.toLowerCase(),
    };
    
    console.log(`   ✓ Pool${i} manifest entry created`);
    console.log(`      Address: ${pools[i]}`);
    console.log(`      Orbit: ${i < 2 ? "NEG" : "POS"}, Offset: ${targetOffsetBps} bps`);
    console.log(`      Reserves: ${ethers.formatUnits(reserveAsset, assetDecimals)} ASSET, ${ethers.formatUnits(reserveUsdc, usdcDecimals)} USDC`);
  }
  
  // Write pool manifest to separate file
  // Convert BigInt values to strings for JSON serialization
  const poolManifestPath = path.join(process.cwd(), "pool-manifest.json");
  const manifestJson = JSON.stringify(poolManifest, (key, value) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  }, 2);
  fs.writeFileSync(poolManifestPath, manifestJson);
  console.log(`\n✓ Pool manifest saved to: ${poolManifestPath}`);

  // Step 4: Set router address on all pools (required for flipOffset)
  console.log("\n4. Setting router address on all pools...");
  const PoolFactoryForRouter = await ethers.getContractFactory("LPPPool");
  
  for (let i = 0; i < 4; i++) {
    const pool = PoolFactoryForRouter.attach(pools[i]).connect(deployer);
    const currentRouter = await pool.router();
    if (currentRouter.toLowerCase() === routerAddr.toLowerCase()) {
      console.log(`   ⏭ Pool${i} already has router set, skipping`);
      continue;
    }
    const tx = await pool.setRouter(routerAddr);
    await tx.wait();
    console.log(`   ✓ Router set on Pool${i}`);
  }

  // Step 5: Set daily cap and unpause router
  // (Orbits are now set atomically during bootstrap in Step 2)
  console.log("\n5. Setting daily event cap and unpausing router...");
  
  // Verify orbits were set (they should be if bootstrapTopology succeeded)
  const negOrbit = [pools[0], pools[1]];
  const posOrbit = [pools[2], pools[3]];
  let allOrbitsSet = true;
  
  for (let i = 0; i < 4; i++) {
    try {
      const dualOrbit = await router.getDualOrbit(pools[i]);
      const existingNeg = dualOrbit[0] as string[];
      const existingPos = dualOrbit[1] as string[];
      if (existingNeg.length !== 2 || existingPos.length !== 2 ||
          existingNeg[0].toLowerCase() !== negOrbit[0].toLowerCase() ||
          existingNeg[1].toLowerCase() !== negOrbit[1].toLowerCase() ||
          existingPos[0].toLowerCase() !== posOrbit[0].toLowerCase() ||
          existingPos[1].toLowerCase() !== posOrbit[1].toLowerCase()) {
        allOrbitsSet = false;
        break;
      }
    } catch {
      allOrbitsSet = false;
      break;
    }
  }
  
  if (!allOrbitsSet) {
    console.log(`   ⚠ WARNING: Orbits are not set correctly.`);
    console.log(`   ⚠ Router will remain PAUSED until orbits are configured.`);
    throw new Error("Orbits were not set during bootstrap. This should not happen if bootstrapTopology succeeded.");
  }
  
  console.log(`   ✓ All orbits are set correctly`);
  
  // Set daily cap
  const dailyCap = 500; // From guide
  const currentCap = await router.dailyEventCap();
  if (currentCap === dailyCap) {
    console.log(`   ⏭ Daily event cap already set to ${dailyCap}, skipping`);
  } else {
    try {
      console.log(`   Setting daily event cap to ${dailyCap}...`);
      const capTx = await treasury.setDailyEventCapViaTreasury(routerAddr, dailyCap);
      
      if (!capTx.hash) {
        throw new Error("Transaction hash is missing - transaction was not broadcast");
      }
      
      console.log(`   ✓ Transaction sent (tx: ${capTx.hash})`);
      console.log(`   View on BaseScan: https://basescan.org/tx/${capTx.hash}`);
      
      const receipt = await capTx.wait();
      if (receipt && receipt.status === 1) {
        console.log(`   ✓ Daily event cap set to: ${dailyCap}`);
      } else {
        throw new Error(`Transaction failed with status ${receipt?.status}`);
      }
    } catch (capError: any) {
      console.error(`   ❌ Failed to set daily event cap: ${capError.message}`);
      console.error(`   ⚠ Router will remain PAUSED until daily cap is set.`);
      throw new Error(`Failed to set daily event cap. Router must remain paused.`);
    }
  }
  
  // Unpause router (orbits and daily cap are set)
  const wasPaused = await router.paused();
  if (wasPaused) {
    console.log(`   Unpausing router...`);
    try {
      const unpauseTx = await treasury.unpauseRouterViaTreasury(routerAddr);
      await unpauseTx.wait();
      console.log(`   ✓ Router unpaused - swaps are now enabled`);
    } catch (unpauseError: any) {
      console.error(`   ❌ Failed to unpause router: ${unpauseError.message}`);
      console.error(`   ⚠ Router will remain PAUSED. Manually unpause with:`);
      console.error(`      treasury.unpauseRouterViaTreasury(${routerAddr})`);
    }
  } else {
    console.log(`   ⏭ Router already unpaused`);
  }

  // Step 6: Update deployment manifest with pool addresses
  console.log("\n6. Updating deployment manifest...");
  manifest.pools = {
    pool0: { address: pools[0], offset: -500, orbit: "NEG" },
    pool1: { address: pools[1], offset: -500, orbit: "NEG" },
    pool2: { address: pools[2], offset: 500, orbit: "POS" },
    pool3: { address: pools[3], offset: 500, orbit: "POS" },
  };
  manifest.topology = {
    negOrbit: negOrbit,
    posOrbit: posOrbit,
    registeredUnder: pools, // All pools can be used as startPool
  };
  manifest.section3CompletedAt = new Date().toISOString();
  manifest.poolManifestPath = poolManifestPath;

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log("✓ Deployment manifest updated with pool addresses");

  console.log("\n=== Section 3 Complete ===");
  console.log("\nPool Addresses:");
  console.log("  Pool0 (NEG, -500 bps):", pools[0]);
  console.log("  Pool1 (NEG, -500 bps):", pools[1]);
  console.log("  Pool2 (POS, +500 bps):", pools[2]);
  console.log("  Pool3 (POS, +500 bps):", pools[3]);
  console.log("\nNEG Orbit:", negOrbit);
  console.log("POS Orbit:", posOrbit);
  console.log("\nNext: Deploy and wait for MEV bots to discover the contracts!");
  console.log("Monitor events: HopExecuted, OrbitFlipped, OffsetFlipped, FeeTaken");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

