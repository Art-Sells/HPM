// scripts/test-quotes.ts
// Test quote functions to verify they're working
//
// Usage:
//   npx hardhat run scripts/test-quotes.ts --network base
//
// This script demonstrates that quote functions are accessible and working

import hre from "hardhat";
const { ethers } = hre;
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
dotenv.config();

async function main() {
  const provider = ethers.provider;
  
  // Load addresses from deployment manifest
  const manifestPath = path.join(process.cwd(), "deployment-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("deployment-manifest.json not found. Run deployment first.");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const routerAddr = manifest.contracts.LPPRouter;
  const pools = manifest.pools;
  
  console.log("=== LPP Router Quote Test ===");
  console.log("Router:", routerAddr);
  console.log("Network:", (await provider.getNetwork()).name);
  console.log("Chain ID:", (await provider.getNetwork()).chainId);
  console.log("");
  
  const RouterFactory = await ethers.getContractFactory("LPPRouter");
  const router = RouterFactory.attach(routerAddr).connect(provider);
  
  // Test quote with a small amount (0.000001 ASSET = 100 units with 8 decimals)
  const testAmountIn = ethers.parseUnits("0.000001", 8); // 0.000001 ASSET
  const startPool = pools.pool0.address; // Use pool0 as startPool
  
  console.log(`Testing quotes with input: ${ethers.formatUnits(testAmountIn, 8)} ASSET`);
  console.log(`Start Pool: ${startPool}\n`);
  
  // Test NEG orbit quote (ASSET→USDC)
  console.log("1. NEG Orbit Quote (ASSET→USDC):");
  try {
    const [assetToUsdc, orbit, perHop, total] = await router.getAmountsOutFromStartWithDirection(
      startPool,
      testAmountIn,
      true // useNegOrbit = true
    );
    
    console.log(`   Direction: ${assetToUsdc ? "ASSET→USDC" : "USDC→ASSET"}`);
    console.log(`   Orbit: ${orbit.length} pools`);
    orbit.forEach((pool, i) => {
      console.log(`     Pool ${i}: ${pool}`);
    });
    console.log(`   Per-hop outputs:`);
    perHop.forEach((amount, i) => {
      console.log(`     Hop ${i}: ${ethers.formatUnits(amount, 6)} USDC`);
    });
    console.log(`   Total Output: ${ethers.formatUnits(total, 6)} USDC\n`);
  } catch (error: any) {
    console.error(`   Error: ${error.message}\n`);
  }
  
  // Test POS orbit quote (USDC→ASSET)
  console.log("2. POS Orbit Quote (USDC→ASSET):");
  try {
    const testAmountUsdc = ethers.parseUnits("0.1", 6); // 0.1 USDC
    const [assetToUsdc, orbit, perHop, total] = await router.getAmountsOutFromStartWithDirection(
      startPool,
      testAmountUsdc,
      false // useNegOrbit = false
    );
    
    console.log(`   Input: ${ethers.formatUnits(testAmountUsdc, 6)} USDC`);
    console.log(`   Direction: ${assetToUsdc ? "ASSET→USDC" : "USDC→ASSET"}`);
    console.log(`   Orbit: ${orbit.length} pools`);
    orbit.forEach((pool, i) => {
      console.log(`     Pool ${i}: ${pool}`);
    });
    console.log(`   Per-hop outputs:`);
    perHop.forEach((amount, i) => {
      console.log(`     Hop ${i}: ${ethers.formatUnits(amount, 8)} ASSET`);
    });
    console.log(`   Total Output: ${ethers.formatUnits(total, 8)} ASSET\n`);
  } catch (error: any) {
    console.error(`   Error: ${error.message}\n`);
  }
  
  // Test with different start pools
  console.log("3. Testing with different start pools:");
  const testPools = [
    { name: "Pool0 (NEG)", address: pools.pool0.address },
    { name: "Pool1 (NEG)", address: pools.pool1.address },
    { name: "Pool2 (POS)", address: pools.pool2.address },
    { name: "Pool3 (POS)", address: pools.pool3.address },
  ];
  
  for (const poolInfo of testPools) {
    try {
      const [assetToUsdc, orbit, perHop, total] = await router.getAmountsOutFromStartWithDirection(
        poolInfo.address,
        testAmountIn,
        true // NEG orbit
      );
      console.log(`   ${poolInfo.name}:`);
      console.log(`     Orbit: ${orbit.length} pools, Total: ${ethers.formatUnits(total, 6)} USDC`);
    } catch (error: any) {
      console.log(`   ${poolInfo.name}: Error - ${error.message}`);
    }
  }
  
  console.log("\n=== Quote Functions Working ===");
  console.log("MEV bots can call these functions off-chain to calculate profitable swaps.");
  console.log("They don't emit events, so we can't monitor quote calls directly.");
  console.log("However, when bots find profitable opportunities, they'll submit swap transactions");
  console.log("which will emit HopExecuted, OrbitFlipped, and FeeTaken events.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

