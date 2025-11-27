// scripts/test-mainnet-quotes.ts
// Test quote functions on Base mainnet and snapshot results
//
// Usage:
//   npx hardhat run scripts/test-mainnet-quotes.ts --network base

import hre from "hardhat";
const { ethers } = hre;
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
dotenv.config();

async function main() {
  const provider = ethers.provider;
  
  // Load tester credentials
  const testerKey = process.env.MASS_TESTER_KEY;
  const testerAddress = process.env.MASS_TESTER_ADDRESS;
  
  if (!testerKey) {
    throw new Error("MASS_TESTER_KEY not found in .env");
  }
  if (!testerAddress) {
    throw new Error("MASS_TESTER_ADDRESS not found in .env");
  }
  
  const tester = new ethers.Wallet(testerKey, provider);
  console.log("Tester Address:", await tester.getAddress());
  console.log("Expected:", testerAddress);
  console.log("Match:", (await tester.getAddress()).toLowerCase() === testerAddress.toLowerCase());
  console.log("");
  
  // Load addresses from deployment manifest
  const manifestPath = path.join(process.cwd(), "test/Deployment/deployment-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("deployment-manifest.json not found. Run deployment first.");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const routerAddr = manifest.contracts.FAFERouter;
  const pools = manifest.pools;
  
  console.log("=== Mainnet Quote Test ===");
  console.log("Router:", routerAddr);
  console.log("Network:", (await provider.getNetwork()).name);
  console.log("Chain ID:", (await provider.getNetwork()).chainId);
  console.log("");
  
  const RouterFactory = await ethers.getContractFactory("FAFERouter");
  const router = RouterFactory.attach(routerAddr).connect(tester);
  
  // Test amounts
  const amountCBBTC = ethers.parseUnits("0.000002", 8); // 0.000002 cbBTC (8 decimals)
  const amountUSDC = ethers.parseUnits("0.15", 6); // 0.15 USDC (6 decimals)
  
  const results: any = {
    timestamp: new Date().toISOString(),
    router: routerAddr,
    network: (await provider.getNetwork()).name,
    chainId: Number((await provider.getNetwork()).chainId),
    quotes: [],
  };
  
  // Test 1: 0.000002 cbBTC → USDC (NEG orbit)
  console.log("1. Testing 0.000002 cbBTC → USDC (NEG orbit):");
  const startPool1 = pools.pool0.address;
  try {
    // Use the deployed contract's getAmountsOutFromStartWithCost function
    const [assetToUsdc1, orbit1, perHop1, total1, totalInputCost1, totalFees1] = await router.getAmountsOutFromStartWithCost(
      startPool1,
      amountCBBTC,
      true // useNegOrbit = true (ASSET→USDC)
    );
    
    const quote1 = {
      test: "0.000002 cbBTC → USDC (NEG orbit)",
      input: {
        amount: ethers.formatUnits(amountCBBTC, 8),
        token: "cbBTC",
        decimals: 8,
        raw: amountCBBTC.toString(),
      },
      startPool: startPool1,
      orbit: {
        direction: assetToUsdc1 ? "ASSET→USDC" : "USDC→ASSET",
        useNegOrbit: true,
        pools: orbit1,
        poolCount: orbit1.length,
      },
      cost: {
        totalInputCost: {
          amount: ethers.formatUnits(totalInputCost1, 8),
          token: "cbBTC",
          raw: totalInputCost1.toString(),
          explanation: `Total extracted from wallet: ${orbit1.length} hops × ${ethers.formatUnits(amountCBBTC, 8)} cbBTC + fees`,
        },
        totalFees: {
          amount: ethers.formatUnits(totalFees1, 8),
          token: "cbBTC",
          raw: totalFees1.toString(),
          explanation: `Fees: ${orbit1.length} hops × 1.2% per hop`,
        },
      },
      outputs: {
        perHop: perHop1.map((amt, i) => ({
          hop: i,
          amount: ethers.formatUnits(amt, 6),
          token: "USDC",
          raw: amt.toString(),
        })),
        total: {
          amount: ethers.formatUnits(total1, 6),
          token: "USDC",
          raw: total1.toString(),
        },
      },
      profitability: {
        netOutput: ethers.formatUnits(total1, 6),
        totalCost: ethers.formatUnits(totalInputCost1, 8),
        note: "To calculate profit, convert costs/outputs to same token and compare",
      },
    };
    
    results.quotes.push(quote1);
    
    console.log(`   Input: ${ethers.formatUnits(amountCBBTC, 8)} cbBTC`);
    console.log(`   Direction: ${quote1.orbit.direction}`);
    console.log(`   Orbit: ${orbit1.length} pools`);
    orbit1.forEach((pool, i) => {
      console.log(`     Pool ${i}: ${pool}`);
    });
    console.log(`   Total Cost (extracted from wallet): ${ethers.formatUnits(totalInputCost1, 8)} cbBTC`);
    console.log(`     - Principal: ${orbit1.length} × ${ethers.formatUnits(amountCBBTC, 8)} = ${ethers.formatUnits(amountCBBTC * BigInt(orbit1.length), 8)} cbBTC`);
    console.log(`     - Fees: ${ethers.formatUnits(totalFees1, 8)} cbBTC (${orbit1.length} × 1.2%)`);
    console.log(`   Per-hop outputs:`);
    perHop1.forEach((amount, i) => {
      console.log(`     Hop ${i}: ${ethers.formatUnits(amount, 6)} USDC`);
    });
    console.log(`   Total Output: ${ethers.formatUnits(total1, 6)} USDC\n`);
  } catch (error: any) {
    console.error(`   Error: ${error.message}\n`);
    results.quotes.push({
      test: "0.000002 cbBTC → USDC (NEG orbit)",
      error: error.message,
    });
  }
  
  // Test 2: 0.15 USDC → cbBTC (POS orbit)
  console.log("2. Testing 0.15 USDC → cbBTC (POS orbit):");
  const startPool2 = pools.pool2.address;
  try {
    // Use the deployed contract's getAmountsOutFromStartWithCost function
    const [assetToUsdc2, orbit2, perHop2, total2, totalInputCost2, totalFees2] = await router.getAmountsOutFromStartWithCost(
      startPool2,
      amountUSDC,
      false // useNegOrbit = false (USDC→ASSET, POS orbit)
    );
    
    const quote2 = {
      test: "0.15 USDC → cbBTC (POS orbit)",
      input: {
        amount: ethers.formatUnits(amountUSDC, 6),
        token: "USDC",
        decimals: 6,
        raw: amountUSDC.toString(),
      },
      startPool: startPool2,
      orbit: {
        direction: assetToUsdc2 ? "ASSET→USDC" : "USDC→ASSET",
        useNegOrbit: false,
        pools: orbit2,
        poolCount: orbit2.length,
      },
      cost: {
        totalInputCost: {
          amount: ethers.formatUnits(totalInputCost2, 6),
          token: "USDC",
          raw: totalInputCost2.toString(),
          explanation: `Total extracted from wallet: ${orbit2.length} hops × ${ethers.formatUnits(amountUSDC, 6)} USDC + fees`,
        },
        totalFees: {
          amount: ethers.formatUnits(totalFees2, 6),
          token: "USDC",
          raw: totalFees2.toString(),
          explanation: `Fees: ${orbit2.length} hops × 1.2% per hop`,
        },
      },
      outputs: {
        perHop: perHop2.map((amt, i) => ({
          hop: i,
          amount: ethers.formatUnits(amt, 8),
          token: "cbBTC",
          raw: amt.toString(),
        })),
        total: {
          amount: ethers.formatUnits(total2, 8),
          token: "cbBTC",
          raw: total2.toString(),
        },
      },
      profitability: {
        netOutput: ethers.formatUnits(total2, 8),
        totalCost: ethers.formatUnits(totalInputCost2, 6),
        note: "To calculate profit, convert costs/outputs to same token and compare",
      },
    };
    
    results.quotes.push(quote2);
    
    console.log(`   Input: ${ethers.formatUnits(amountUSDC, 6)} USDC`);
    console.log(`   Direction: ${quote2.orbit.direction}`);
    console.log(`   Orbit: ${orbit2.length} pools`);
    orbit2.forEach((pool, i) => {
      console.log(`     Pool ${i}: ${pool}`);
    });
    console.log(`   Total Cost (extracted from wallet): ${ethers.formatUnits(totalInputCost2, 6)} USDC`);
    console.log(`     - Principal: ${orbit2.length} × ${ethers.formatUnits(amountUSDC, 6)} = ${ethers.formatUnits(amountUSDC * BigInt(orbit2.length), 6)} USDC`);
    console.log(`     - Fees: ${ethers.formatUnits(totalFees2, 6)} USDC (${orbit2.length} × 1.2%)`);
    console.log(`   Per-hop outputs:`);
    perHop2.forEach((amount, i) => {
      console.log(`     Hop ${i}: ${ethers.formatUnits(amount, 8)} cbBTC`);
    });
    console.log(`   Total Output: ${ethers.formatUnits(total2, 8)} cbBTC\n`);
  } catch (error: any) {
    console.error(`   Error: ${error.message}\n`);
    results.quotes.push({
      test: "0.15 USDC → cbBTC (POS orbit)",
      error: error.message,
    });
  }
  
  // Test 3: Try different start pools for cbBTC quote
  console.log("3. Testing 0.000002 cbBTC with different start pools:");
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
        amountCBBTC,
        true // NEG orbit
      );
      console.log(`   ${poolInfo.name}: ${ethers.formatUnits(total, 6)} USDC (${orbit.length} pools)`);
      
      results.quotes.push({
        test: `0.000002 cbBTC from ${poolInfo.name}`,
        startPool: poolInfo.address,
        totalOutput: ethers.formatUnits(total, 6),
        orbitCount: orbit.length,
      });
    } catch (error: any) {
      console.log(`   ${poolInfo.name}: Error - ${error.message}`);
    }
  }
  
  // Save snapshot
  const snapshotDir = path.join(process.cwd(), "test", "MEV", "test", "__snapshots__");
  if (!fs.existsSync(snapshotDir)) {
    fs.mkdirSync(snapshotDir, { recursive: true });
  }
  
  const snapshotPath = path.join(snapshotDir, "mainnet-quotes.snap.json");
  fs.writeFileSync(snapshotPath, JSON.stringify(results, null, 2));
  
  console.log("\n=== Quote Test Complete ===");
  console.log(`Snapshot saved to: ${snapshotPath}`);
  console.log(`Total quotes tested: ${results.quotes.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

