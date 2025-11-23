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
  const provider = ethers.provider;

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
    "0xb5889070070C9A666bd411E4D882e3E545f74aE0", // Pool0
    "0xa6c62A4edf110703f69505Ea8fAD940aDc6EAF9D", // Pool1
    "0x439634467E0322759b1a7369a552204ea42A3463", // Pool2
    "0xB1a5D1943612BbEE35ee7720f3a4bba74Fdc68b7", // Pool3
  ];
  
  let previousPoolsBootstrapped = 0;
  const validPreviousPools: string[] = [];
  for (const poolAddr of previousRunPools) {
    try {
      const pool = PoolFactory.attach(poolAddr).connect(provider);
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

  // Step 2: Bootstrap pools with offsets (only if not already bootstrapped)
  console.log("\n2. Bootstrapping pools...");
  
  // Check which pools need bootstrapping
  const poolsAlreadyBootstrapped = await Promise.all(
    pools.map(async (poolAddr) => {
      const pool = PoolFactory.attach(poolAddr).connect(provider);
      return await pool.initialized();
    })
  );
  
  const needBootstrap = poolsAlreadyBootstrapped.filter(b => b === false).length;
  
  if (needBootstrap === 0) {
    console.log("   ✓ All pools are already bootstrapped, skipping bootstrap step");
  } else {
    console.log(`   ${needBootstrap} pools need bootstrapping...`);
    
    // Parse amounts using correct decimals
    // ASSET: 0.000012 (cbBTC has 8 decimals)
    // USDC: 1.0 (USDC has 6 decimals)
    const SEED_AMOUNT_ASSET = ethers.parseUnits("0.000012", assetDecimals);
    const SEED_AMOUNT_USDC = ethers.parseUnits("1", usdcDecimals);
    const requiredAsset = SEED_AMOUNT_ASSET * BigInt(needBootstrap);
    const requiredUsdc = SEED_AMOUNT_USDC * BigInt(needBootstrap);

    // Ensure treasury contract has enough tokens
    // Note: bootstrapViaTreasury transfers FROM treasury contract TO pools
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
    
    // Verify treasury now has enough (re-check after transfers)
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

    // Bootstrap Pool0, Pool1: NEG orbit (-500 bps)
    // Use the 4-parameter overload explicitly to avoid ambiguity
    for (let i = 0; i < 2; i++) {
      if (poolsAlreadyBootstrapped[i]) {
        console.log(`   ⏭ Pool${i} already bootstrapped, skipping`);
        continue;
      }
      try {
        const tx = await (treasury as any)["bootstrapViaTreasury(address,uint256,uint256,int256)"](
          pools[i],
          SEED_AMOUNT_ASSET,
          SEED_AMOUNT_USDC,
          -500
        );
        const receipt = await tx.wait();
        
        // Verify transaction succeeded
        if (!receipt || receipt.status !== 1) {
          throw new Error(`Bootstrap transaction for Pool${i} failed. Status: ${receipt?.status}`);
        }
        
        // Verify pool is actually initialized
        const pool = PoolFactory.attach(pools[i]);
        const isInitialized = await pool.initialized();
        if (!isInitialized) {
          throw new Error(`Pool${i} bootstrap transaction succeeded but pool is not initialized`);
        }
        
        console.log(`   ✓ Pool${i} bootstrapped with -500 bps offset`);
      } catch (error: any) {
        console.error(`   ❌ Failed to bootstrap Pool${i}:`, error.message);
        if (error.reason) {
          console.error(`   Revert reason:`, error.reason);
        }
        throw error;
      }
    }

    // Bootstrap Pool2, Pool3: POS orbit (+500 bps)
    for (let i = 2; i < 4; i++) {
      if (poolsAlreadyBootstrapped[i]) {
        console.log(`   ⏭ Pool${i} already bootstrapped, skipping`);
        continue;
      }
      try {
        const tx = await (treasury as any)["bootstrapViaTreasury(address,uint256,uint256,int256)"](
          pools[i],
          SEED_AMOUNT_ASSET,
          SEED_AMOUNT_USDC,
          500
        );
        const receipt = await tx.wait();
        
        // Verify transaction succeeded
        if (!receipt || receipt.status !== 1) {
          throw new Error(`Bootstrap transaction for Pool${i} failed. Status: ${receipt?.status}`);
        }
        
        // Verify pool is actually initialized
        const pool = PoolFactory.attach(pools[i]);
        const isInitialized = await pool.initialized();
        if (!isInitialized) {
          throw new Error(`Pool${i} bootstrap transaction succeeded but pool is not initialized`);
        }
        
        console.log(`   ✓ Pool${i} bootstrapped with +500 bps offset`);
      } catch (error: any) {
        console.error(`   ❌ Failed to bootstrap Pool${i}:`, error.message);
        if (error.reason) {
          console.error(`   Revert reason:`, error.reason);
        }
        throw error;
      }
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
    const pool = PoolFactory.attach(pools[i]).connect(provider);
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

  // Step 5: Register dual orbits
  console.log("\n5. Registering dual orbits...");
  
  // Verify deployer is treasury owner (already checked in step 1c)
  const deployerAddress = await deployer.getAddress();
  if (treasuryOwner.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(`Deployer ${deployerAddress} is not the treasury owner. Owner is: ${treasuryOwner}`);
  }
  console.log(`   ✓ Deployer is treasury owner`);
  
  // Verify router's treasury matches our treasury (required for onlyTreasury check)
  const routerTreasury = await router.treasury();
  if (routerTreasury.toLowerCase() !== treasuryAddr.toLowerCase()) {
    throw new Error(`Router's treasury (${routerTreasury}) does not match our treasury (${treasuryAddr}). Cannot set orbits.`);
  }
  console.log(`   ✓ Router's treasury matches our treasury`);
  
  // Pause the router BEFORE attempting orbit registration to prevent swaps until orbits are set
  console.log(`   Pausing router to prevent swaps until orbits are configured...`);
  const wasPaused = await router.paused();
  if (!wasPaused) {
    const pauseTx = await treasury.pauseRouterViaTreasury(routerAddr);
    await pauseTx.wait();
    console.log(`   ✓ Router paused`);
  } else {
    console.log(`   ⏭ Router already paused`);
  }
  
  // NEG orbit: Pool0, Pool1
  const negOrbit = [pools[0], pools[1]];
  // POS orbit: Pool2, Pool3
  const posOrbit = [pools[2], pools[3]];
  
  // Verify all pools have matching asset/usdc pairs (required by router)
  console.log(`   Verifying pool token pairs...`);
  const pool0 = PoolFactory.attach(pools[0]).connect(provider);
  const pool0Asset = await pool0.asset();
  const pool0Usdc = await pool0.usdc();
  
  for (let i = 1; i < 4; i++) {
    const pool = PoolFactory.attach(pools[i]).connect(provider);
    const poolAsset = await pool.asset();
    const poolUsdc = await pool.usdc();
    if (poolAsset.toLowerCase() !== pool0Asset.toLowerCase() || poolUsdc.toLowerCase() !== pool0Usdc.toLowerCase()) {
      throw new Error(`Pool${i} has mismatched token pair. Pool0: ${pool0Asset}/${pool0Usdc}, Pool${i}: ${poolAsset}/${poolUsdc}`);
    }
  }
  console.log(`   ✓ All pools have matching token pairs (${pool0Asset}/${pool0Usdc})`);
  
  // Check pool state before attempting orbit registration
  console.log(`   Checking pool state...`);
  const poolsState: Array<{addr: string, initialized: boolean, offset: number, hasFunds: boolean}> = [];
  for (let i = 0; i < 4; i++) {
    const pool = PoolFactory.attach(pools[i]).connect(provider);
    const isInitialized = await pool.initialized();
    const targetOffsetBps = await pool.targetOffsetBps();
    const reserveAsset = await pool.reserveAsset();
    const reserveUsdc = await pool.reserveUsdc();
    const hasFunds = reserveAsset > 0n || reserveUsdc > 0n;
    poolsState.push({
      addr: pools[i],
      initialized: isInitialized,
      offset: Number(targetOffsetBps),
      hasFunds: hasFunds
    });
    console.log(`      Pool${i}: initialized=${isInitialized}, offset=${targetOffsetBps} bps, hasFunds=${hasFunds}`);
  }

  // Register the same orbit config under ALL pool addresses
  // This allows searchers to use any pool as startPool lookup key
  // Check if orbits are already registered
  const routerForCheck = RouterFactory.attach(routerAddr);
  for (let i = 0; i < 4; i++) {
    try {
      // Check if orbit is already registered
      let alreadyRegistered = false;
      try {
        const dualOrbit = await routerForCheck.getDualOrbit(pools[i]);
        if (dualOrbit[2] === true) { // initialized flag
          // Verify it matches our expected orbits
          const existingNeg = dualOrbit[0] as string[];
          const existingPos = dualOrbit[1] as string[];
          if (existingNeg.length === 2 && existingPos.length === 2 &&
              existingNeg[0].toLowerCase() === negOrbit[0].toLowerCase() &&
              existingNeg[1].toLowerCase() === negOrbit[1].toLowerCase() &&
              existingPos[0].toLowerCase() === posOrbit[0].toLowerCase() &&
              existingPos[1].toLowerCase() === posOrbit[1].toLowerCase()) {
            alreadyRegistered = true;
          }
        }
      } catch {
        // Orbit not registered, continue to register
      }
      
      if (alreadyRegistered) {
        console.log(`   ⏭ Dual orbit already registered under Pool${i}, skipping`);
        continue;
      }
      
      // Verify pool details before attempting registration
      console.log(`      Verifying Pool${i} and orbit pools...`);
      const poolCheck = PoolFactory.attach(pools[i]).connect(provider);
      const poolAsset = await poolCheck.asset();
      const poolUsdc = await poolCheck.usdc();
      const poolInitialized = await poolCheck.initialized();
      console.log(`         Pool${i}: Asset=${poolAsset}, USDC=${poolUsdc}, Initialized=${poolInitialized}`);
      
      // Verify all NEG orbit pools
      for (let j = 0; j < negOrbit.length; j++) {
        const negPool = PoolFactory.attach(negOrbit[j]).connect(provider);
        const negAsset = await negPool.asset();
        const negUsdc = await negPool.usdc();
        const negInit = await negPool.initialized();
        console.log(`         NEG[${j}]: Asset=${negAsset}, USDC=${negUsdc}, Initialized=${negInit}`);
        if (negAsset.toLowerCase() !== poolAsset.toLowerCase() || negUsdc.toLowerCase() !== poolUsdc.toLowerCase()) {
          throw new Error(`NEG orbit pool ${j} (${negOrbit[j]}) has mismatched tokens. Expected ${poolAsset}/${poolUsdc}, got ${negAsset}/${negUsdc}`);
        }
      }
      
      // Verify all POS orbit pools
      for (let j = 0; j < posOrbit.length; j++) {
        const posPool = PoolFactory.attach(posOrbit[j]).connect(provider);
        const posAsset = await posPool.asset();
        const posUsdc = await posPool.usdc();
        const posInit = await posPool.initialized();
        console.log(`         POS[${j}]: Asset=${posAsset}, USDC=${posUsdc}, Initialized=${posInit}`);
        if (posAsset.toLowerCase() !== poolAsset.toLowerCase() || posUsdc.toLowerCase() !== poolUsdc.toLowerCase()) {
          throw new Error(`POS orbit pool ${j} (${posOrbit[j]}) has mismatched tokens. Expected ${poolAsset}/${poolUsdc}, got ${posAsset}/${posUsdc}`);
        }
      }
      
      // Verify router contract code exists and matches our expectations
      const routerCode = await provider.getCode(routerAddr);
      if (routerCode === "0x") {
        throw new Error(`Router contract has no code at ${routerAddr}. Contract may not be deployed.`);
      }
      console.log(`      ✓ Router contract has code (${routerCode.length} bytes)`);
      
      // Double-check router's treasury matches
      const routerTreasuryCheck = await router.treasury();
      if (routerTreasuryCheck.toLowerCase() !== treasuryAddr.toLowerCase()) {
        throw new Error(`Router treasury mismatch! Router expects ${routerTreasuryCheck}, but we're using ${treasuryAddr}`);
      }
      console.log(`      ✓ Router treasury verified: ${routerTreasuryCheck}`);
      
      // Try the transaction - use a reasonable gas limit
      // The RPC error suggests it needs ~27k gas, but we'll use 100k for safety
      console.log(`      Attempting transaction...`);
      try {
        // Get current fee data from provider - Base should have very low gas prices
        const feeData = await provider.getFeeData();
        // Use provider's suggested fees, but ensure they're reasonable
        let maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits("0.1", "gwei");
        let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits("0.001", "gwei");
        
        // Cap at 1 gwei to avoid excessive fees (Base should be much lower)
        const maxAllowed = ethers.parseUnits("1", "gwei");
        if (maxFeePerGas > maxAllowed) {
          console.log(`      ⚠ Provider suggested ${ethers.formatUnits(maxFeePerGas, "gwei")} gwei, capping at 1 gwei`);
          maxFeePerGas = maxAllowed;
        }
        
        console.log(`      Using gas price: ${ethers.formatUnits(maxFeePerGas, "gwei")} gwei (priority: ${ethers.formatUnits(maxPriorityFeePerGas, "gwei")} gwei)`);
        
        // Try to estimate actual gas needed first
        let gasLimit = 50000n; // Start with 50k - the error said ~27k was needed
        try {
          const estimatedGas = await treasury.setDualOrbitViaTreasury.estimateGas(
            routerAddr,
            pools[i],
            negOrbit,
            posOrbit,
            true
          );
          // Use 150% of estimated gas for safety
          gasLimit = (estimatedGas * 150n) / 100n;
          console.log(`      Estimated gas: ${estimatedGas.toString()}, using: ${gasLimit.toString()}`);
        } catch {
          // If estimation fails, use 50k
          console.log(`      Gas estimation failed, using default: ${gasLimit.toString()}`);
        }
        
        const estimatedCost = maxFeePerGas * gasLimit;
        console.log(`      Estimated cost: ${ethers.formatEther(estimatedCost)} ETH ($${(Number(estimatedCost) / 1e18 * 2500).toFixed(6)} at $2500/ETH)`);
        
        const tx = await treasury.setDualOrbitViaTreasury(
          routerAddr,
          pools[i],  // startPool: any pool can be used as lookup key
          negOrbit,  // NEG orbit: 2 pools (pool0, pool1)
          posOrbit,  // POS orbit: 2 pools (pool2, pool3)
          true,      // deprecated: kept for backwards compatibility
          { 
            gasLimit: gasLimit,
            maxFeePerGas: maxFeePerGas,
            maxPriorityFeePerGas: maxPriorityFeePerGas
          }
        );
        console.log(`      ✓ Transaction sent (tx: ${tx.hash})`);
        console.log(`      Waiting for confirmation (this may take 10-30 seconds)...`);
        console.log(`      View on BaseScan: https://basescan.org/tx/${tx.hash}`);
        
        // Wait for confirmation with progress updates
        const receiptPromise = tx.wait();
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Transaction confirmation timeout after 60 seconds")), 60000)
        );
        
        // Show progress every 5 seconds
        const progressInterval = setInterval(() => {
          process.stdout.write(".");
        }, 5000);
        
        try {
          const receipt = await Promise.race([receiptPromise, timeoutPromise]) as any;
          clearInterval(progressInterval);
          process.stdout.write("\n");
          
          // Check if transaction actually succeeded
          if (receipt && receipt.status === 1) {
            console.log(`   ✓ Dual orbit registered under Pool${i} as startPool`);
          } else {
            throw new Error(`Transaction failed with status ${receipt?.status}`);
          }
        } catch (txError: any) {
          clearInterval(progressInterval);
          process.stdout.write("\n");
          // If transaction fails, try to get more details
          console.error(`      ❌ Transaction failed: ${txError.message}`);
          if (txError.reason) {
            console.error(`      Revert reason: ${txError.reason}`);
          }
          if (txError.transaction) {
            console.error(`      Transaction hash: ${txError.transaction.hash}`);
          }
          if (txError.data) {
            console.error(`      Error data: ${txError.data.substring(0, 200)}...`);
          }
          // Check if this is a timeout - if so, the transaction might still be pending
          if (txError.message.includes("timeout")) {
            console.error(`      ⚠ Transaction confirmation timed out, but transaction may still be pending.`);
            console.error(`      ⚠ Check the transaction hash on a blockchain explorer.`);
          }
          throw txError;
        }
      } catch (error: any) {
        console.error(`   ❌ Failed to register orbit for Pool${i}:`, error.message);
        if (error.data) {
          console.error(`   Error data:`, error.data);
        }
        // Try to decode revert reason if available
        if (error.reason) {
          console.error(`   Revert reason:`, error.reason);
        }
        
        // Check if orbits aren't set AND pools have funds - this is a recovery scenario
        const poolState = poolsState[i];
        if (poolState.hasFunds && !poolState.initialized) {
          console.error(`   ⚠ WARNING: Pool${i} has funds (${poolState.addr}) but is not initialized.`);
          console.error(`   ⚠ Funds cannot be directly withdrawn from pools - they are locked in reserves.`);
          console.error(`   ⚠ Consider using swaps to recover funds if needed.`);
        }
        
        // Don't throw - continue to try other pools, but log the failure
        console.error(`   ⚠ Continuing with other pools...`);
      }
    } catch (outerError: any) {
      // This catch handles any errors from the outer try block (line 630)
      console.error(`   ❌ Failed to register orbit for Pool${i}:`, outerError.message);
      console.error(`   ⚠ Continuing with other pools...`);
    }
  }
  
  // Final check: Verify orbits were set successfully
  console.log(`\n   Verifying orbit registration...`);
  let allOrbitsSet = true;
  for (let i = 0; i < 4; i++) {
    try {
      const dualOrbit = await router.getDualOrbit(pools[i]);
      if (dualOrbit[2] === true) {
        console.log(`      ✓ Pool${i}: Orbit registered`);
      } else {
        console.log(`      ⚠ Pool${i}: Orbit not registered`);
        allOrbitsSet = false;
      }
    } catch {
      console.log(`      ⚠ Pool${i}: Orbit not registered (error checking)`);
      allOrbitsSet = false;
    }
  }
  
  // Note: Router will be unpaused after Step 6 (daily cap) if all orbits were set successfully
  if (!allOrbitsSet) {
    console.log(`\n   ⚠ WARNING: Not all orbits were registered successfully.`);
    console.log(`   ⚠ Router will remain PAUSED to prevent swaps until orbits are configured.`);
    console.log(`   ⚠ Pools with funds but unregistered orbits have locked funds.`);
    console.log(`   ⚠ Run 'npx hardhat run scripts/recover-pool-funds.ts --network base' to check pool state.`);
    console.log(`   ⚠ Once orbits are registered, manually unpause the router with:`);
    console.log(`      treasury.unpauseRouterViaTreasury(${routerAddr})`);
  }

  // Step 6: Set daily cap (REQUIRED - router must remain paused until this is set)
  console.log("\n6. Setting daily event cap (REQUIRED)...");
  const dailyCap = 500; // From guide
  const currentCap = await router.dailyEventCap();
  if (currentCap === dailyCap) {
    console.log(`   ⏭ Daily event cap already set to ${dailyCap}, skipping`);
  } else {
    try {
      const maxFeePerGas = ethers.parseUnits("0.1", "gwei");
      const maxPriorityFeePerGas = ethers.parseUnits("0.001", "gwei");
      console.log(`   Sending transaction to set daily cap to ${dailyCap}...`);
      const capTx = await treasury.setDailyEventCapViaTreasury(routerAddr, dailyCap, { 
        gasLimit: 100000n,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas
      });
      console.log(`   ✓ Transaction sent (tx: ${capTx.hash})`);
      console.log(`   View on BaseScan: https://basescan.org/tx/${capTx.hash}`);
      console.log(`   Waiting for confirmation (this may take 10-30 seconds)...`);
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
  
  // Unpause router ONLY if all orbits were set successfully AND daily cap is set
  if (allOrbitsSet) {
    console.log(`\n   ✓ All orbits registered successfully`);
    console.log(`   ✓ Daily event cap is set`);
    if (!wasPaused) {
      console.log(`   Unpausing router...`);
      try {
        const maxFeePerGas = ethers.parseUnits("0.1", "gwei");
        const maxPriorityFeePerGas = ethers.parseUnits("0.001", "gwei");
        const unpauseTx = await treasury.unpauseRouterViaTreasury(routerAddr, { 
          gasLimit: 100000n,
          maxFeePerGas: maxFeePerGas,
          maxPriorityFeePerGas: maxPriorityFeePerGas
        });
        await unpauseTx.wait();
        console.log(`   ✓ Router unpaused - swaps are now enabled`);
      } catch (unpauseError: any) {
        console.error(`   ❌ Failed to unpause router: ${unpauseError.message}`);
        console.error(`   ⚠ Router will remain PAUSED. Manually unpause with:`);
        console.error(`      treasury.unpauseRouterViaTreasury(${routerAddr})`);
      }
    } else {
      console.log(`   ⏭ Router was already paused before, keeping it paused`);
    }
  } else {
    console.log(`\n   ⚠ Router will remain PAUSED because not all orbits were registered.`);
  }

  // Step 7: Update deployment manifest with pool addresses (simplified)
  console.log("\n7. Updating deployment manifest...");
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

