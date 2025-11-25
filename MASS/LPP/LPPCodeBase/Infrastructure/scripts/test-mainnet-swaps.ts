// scripts/test-mainnet-swaps.ts
// Test actual swaps on Base mainnet like MEV bots would
//
// Usage:
//   npx hardhat run scripts/test-mainnet-swaps.ts --network base
//
// This script:
//   1. Gets pool state BEFORE swap
//   2. Sets up approvals (router for fees, pools for principal)
//   3. Calls router.swap() like MEV bots do
//   4. Gets pool state AFTER swap
//   5. Captures HopExecuted events to see which pools were used
//   6. Saves snapshot in pool-manifest.json format

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
  console.log("");
  
  // Load addresses from deployment manifest
  const manifestPath = path.join(process.cwd(), "deployment-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("deployment-manifest.json not found. Run deployment first.");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const routerAddr = manifest.contracts.LPPRouter;
  const pools = manifest.pools;
  const assetAddr = manifest.tokens.ASSET;
  const usdcAddr = manifest.tokens.USDC;
  
  console.log("=== Mainnet Swap Test (MEV Bot Style) ===");
  console.log("Router:", routerAddr);
  console.log("Network:", (await provider.getNetwork()).name);
  console.log("Chain ID:", (await provider.getNetwork()).chainId);
  console.log("");
  
  const RouterFactory = await ethers.getContractFactory("LPPRouter");
  const router = RouterFactory.attach(routerAddr).connect(tester);
  
  // Get token contracts
  const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function decimals() view returns (uint8)",
  ];
  const asset = new ethers.Contract(assetAddr, ERC20_ABI, tester);
  const usdc = new ethers.Contract(usdcAddr, ERC20_ABI, tester);
  
  const assetDecimals = await asset.decimals();
  const usdcDecimals = await usdc.decimals();
  
  // Get pool contracts
  const PoolFactory = await ethers.getContractFactory("LPPPool");
  const poolContracts = [
    PoolFactory.attach(pools.pool0.address).connect(provider),
    PoolFactory.attach(pools.pool1.address).connect(provider),
    PoolFactory.attach(pools.pool2.address).connect(provider),
    PoolFactory.attach(pools.pool3.address).connect(provider),
  ];
  
  // Helper to get pool state (including on-chain offset)
  async function getPoolState(poolAddr: string, poolContract: any) {
    const reserveAsset = await poolContract.reserveAsset();
    const reserveUsdc = await poolContract.reserveUsdc();
    const targetOffsetBps = await poolContract.targetOffsetBps(); // Query on-chain!
    const priceX96 = await poolContract.priceX96();
    
    // priceX96 is in Q96 format: (reserveUsdc << 96) / reserveAsset
    // This gives the ratio of RAW amounts (with decimals)
    // To get actual USDC per cbBTC, we need to account for decimal difference:
    // price = (priceX96 / 2^96) × (10^assetDecimals / 10^usdcDecimals)
    const priceRatio = Number(priceX96) / Math.pow(2, 96);
    const decimalAdjustment = Math.pow(10, assetDecimals) / Math.pow(10, usdcDecimals); // 10^8 / 10^6 = 100
    const price = priceRatio * decimalAdjustment;
    
    return {
      address: poolAddr,
      reserveAsset: {
        raw: reserveAsset.toString(),
        formatted: ethers.formatUnits(reserveAsset, assetDecimals),
      },
      reserveUsdc: {
        raw: reserveUsdc.toString(),
        formatted: ethers.formatUnits(reserveUsdc, usdcDecimals),
      },
      targetOffsetBps: Number(targetOffsetBps), // On-chain value
      priceX96: priceX96.toString(),
      price: price.toFixed(2), // Format to 2 decimal places (USDC per cbBTC)
    };
  }
  
  // Helper to get all pools state
  async function getAllPoolsState() {
    const states = await Promise.all(
      poolContracts.map((pool, i) => getPoolState(Object.values(pools)[i].address, pool))
    );
    return {
      pool0: states[0],
      pool1: states[1],
      pool2: states[2],
      pool3: states[3],
    };
  }
  
  // Helper to approve max
  async function approveMax(token: any, owner: any, spender: string) {
    const maxApproval = ethers.MaxUint256;
    const currentAllowance = await token.allowance(owner.address, spender);
    if (currentAllowance < maxApproval / 2n) {
      const tx = await token.connect(owner).approve(spender, maxApproval);
      await tx.wait();
      return true;
    }
    return false;
  }
  
  const results: any = {
    timestamp: new Date().toISOString(),
    router: routerAddr,
    network: (await provider.getNetwork()).name,
    chainId: Number((await provider.getNetwork()).chainId),
    swaps: [],
  };
  
  // Test 1: 0.02 USDC → cbBTC (POS orbit)
  console.log("=== Swap 1: 0.02 USDC → cbBTC (POS orbit) ===");
  const amountUSDC = ethers.parseUnits("0.02", usdcDecimals);
  const startPool1 = pools.pool2.address; // POS orbit pool
  
  try {
    // Get quote to determine orbit (like MEV bots do)
    let assetToUsdc1: boolean, orbit1: string[], perHop1: bigint[], total1: bigint;
    let totalInputCost1: bigint, totalFees1: bigint;
    
    try {
      // Try new function first
      [assetToUsdc1, orbit1, perHop1, total1, totalInputCost1, totalFees1] = await router.getAmountsOutFromStartWithCost(
        startPool1,
        amountUSDC,
        false // useNegOrbit = false (USDC→ASSET, POS orbit)
      );
    } catch {
      // Fallback: use old function and calculate cost manually
      [assetToUsdc1, orbit1, perHop1, total1] = await router.getAmountsOutFromStartWithDirection(
        startPool1,
        amountUSDC,
        false
      );
      const MCV_FEE_BPS = 120n;
      const BPS_DENOMINATOR = 10000n;
      const numHops = BigInt(orbit1.length);
      const feePerHop = (amountUSDC * MCV_FEE_BPS) / BPS_DENOMINATOR;
      totalFees1 = feePerHop * numHops;
      totalInputCost1 = (amountUSDC * numHops) + totalFees1;
    }
    
    console.log(`   Quote: ${ethers.formatUnits(amountUSDC, usdcDecimals)} USDC → ${ethers.formatUnits(total1, assetDecimals)} cbBTC`);
    console.log(`   Total Cost: ${ethers.formatUnits(totalInputCost1, usdcDecimals)} USDC`);
    console.log(`   Orbit: ${orbit1.length} pools (POS)`);
    orbit1.forEach((p, i) => console.log(`     Pool ${i}: ${p}`));
    console.log("");
    
    // Get state BEFORE
    console.log("   Getting pool state BEFORE swap...");
    const poolsBefore1 = await getAllPoolsState();
    const testerBalanceBefore1 = {
      asset: await asset.balanceOf(testerAddress),
      usdc: await usdc.balanceOf(testerAddress),
    };
    
    // Set up approvals
    console.log("   Setting up approvals...");
    await approveMax(usdc, tester, routerAddr);
    for (const poolAddr of orbit1) {
      await approveMax(usdc, tester, poolAddr);
    }
    console.log("   ✓ Approvals set");
    
    // Execute swap
    console.log("   Executing swap...");
    const swapParams1 = {
      startPool: startPool1,
      assetToUsdc: false, // POS orbit (USDC→ASSET)
      amountIn: amountUSDC,
      minTotalAmountOut: 0n,
      to: testerAddress,
      payer: testerAddress,
    };
    
    const tx1 = await router.swap(swapParams1);
    console.log(`   ✓ Transaction sent: ${tx1.hash}`);
    console.log(`   View on BaseScan: https://basescan.org/tx/${tx1.hash}`);
    
    const receipt1 = await tx1.wait();
    if (!receipt1 || receipt1.status !== 1) {
      throw new Error(`Swap failed. Status: ${receipt1?.status}`);
    }
    
    // Get state AFTER
    console.log("   Getting pool state AFTER swap...");
    const poolsAfter1 = await getAllPoolsState();
    const testerBalanceAfter1 = {
      asset: await asset.balanceOf(testerAddress),
      usdc: await usdc.balanceOf(testerAddress),
    };
    
    // Parse HopExecuted events
    const HopExecutedSig = ethers.id("HopExecuted(address,bool,address,address,uint256,uint256)");
    const hopEvents1 = (receipt1.logs ?? [])
      .filter((l: any) => l.topics && l.topics[0] === HopExecutedSig)
      .map((l: any) => {
        const pool = ethers.getAddress("0x" + l.topics[1].slice(26));
        const tokenIn = ethers.getAddress("0x" + l.topics[2].slice(26));
        const tokenOut = ethers.getAddress("0x" + l.topics[3].slice(26));
        const [assetToUsdc, amtIn, amtOut] = ethers.AbiCoder.defaultAbiCoder().decode(
          ["bool", "uint256", "uint256"],
          l.data
        );
        return {
          pool,
          assetToUsdc: Boolean(assetToUsdc),
          amountIn: amtIn.toString(),
          amountOut: amtOut.toString(),
          tokenIn,
          tokenOut,
        };
      });
    
    // Parse OffsetFlipped events (event OffsetFlipped(int16 newOffset) - no indexed params)
    const OffsetFlippedSig = ethers.id("OffsetFlipped(int16)");
    const offsetFlippedEvents1 = (receipt1.logs ?? [])
      .filter((l: any) => l.topics && l.topics[0] === OffsetFlippedSig)
      .map((l: any) => {
        const [newOffset] = ethers.AbiCoder.defaultAbiCoder().decode(["int16"], l.data);
        return {
          pool: l.address, // Event emitted by pool contract
          newOffset: Number(newOffset),
        };
      });
    
    console.log(`   ✓ Swap completed. ${hopEvents1.length} hops executed`);
    if (offsetFlippedEvents1.length > 0) {
      console.log(`   ✓ Offset flipped for ${offsetFlippedEvents1.length} pools`);
      offsetFlippedEvents1.forEach((e: any) => {
        console.log(`     Pool ${e.pool}: offset → ${e.newOffset}`);
      });
    }
    console.log("");
    
    // Build snapshot entry
    const swap1Snapshot: any = {
      swap: "0.02 USDC → cbBTC (POS orbit)",
      input: {
        amount: ethers.formatUnits(amountUSDC, usdcDecimals),
        token: "USDC",
        decimals: usdcDecimals,
        raw: amountUSDC.toString(),
      },
      quote: {
        totalOutput: ethers.formatUnits(total1, assetDecimals),
        totalCost: ethers.formatUnits(totalInputCost1, usdcDecimals),
        totalFees: ethers.formatUnits(totalFees1, usdcDecimals),
        orbit: orbit1,
        perHopOutputs: perHop1.map((amt, i) => ({
          hop: i,
          amount: ethers.formatUnits(amt, assetDecimals),
          raw: amt.toString(),
        })),
      },
      transaction: {
        hash: tx1.hash,
        blockNumber: receipt1.blockNumber,
        gasUsed: receipt1.gasUsed.toString(),
        baseScanUrl: `https://basescan.org/tx/${tx1.hash}`,
      },
      pools: {
        before: poolsBefore1,
        after: poolsAfter1,
        offsetChanges: {
          pool0: {
            before: poolsBefore1.pool0.targetOffsetBps,
            after: poolsAfter1.pool0.targetOffsetBps,
            flipped: poolsBefore1.pool0.targetOffsetBps !== poolsAfter1.pool0.targetOffsetBps,
          },
          pool1: {
            before: poolsBefore1.pool1.targetOffsetBps,
            after: poolsAfter1.pool1.targetOffsetBps,
            flipped: poolsBefore1.pool1.targetOffsetBps !== poolsAfter1.pool1.targetOffsetBps,
          },
          pool2: {
            before: poolsBefore1.pool2.targetOffsetBps,
            after: poolsAfter1.pool2.targetOffsetBps,
            flipped: poolsBefore1.pool2.targetOffsetBps !== poolsAfter1.pool2.targetOffsetBps,
          },
          pool3: {
            before: poolsBefore1.pool3.targetOffsetBps,
            after: poolsAfter1.pool3.targetOffsetBps,
            flipped: poolsBefore1.pool3.targetOffsetBps !== poolsAfter1.pool3.targetOffsetBps,
          },
        },
      },
      offsetFlippedEvents: offsetFlippedEvents1,
      testerBalances: {
        before: {
          asset: {
            raw: testerBalanceBefore1.asset.toString(),
            formatted: ethers.formatUnits(testerBalanceBefore1.asset, assetDecimals),
          },
          usdc: {
            raw: testerBalanceBefore1.usdc.toString(),
            formatted: ethers.formatUnits(testerBalanceBefore1.usdc, usdcDecimals),
          },
        },
        after: {
          asset: {
            raw: testerBalanceAfter1.asset.toString(),
            formatted: ethers.formatUnits(testerBalanceAfter1.asset, assetDecimals),
          },
          usdc: {
            raw: testerBalanceAfter1.usdc.toString(),
            formatted: ethers.formatUnits(testerBalanceAfter1.usdc, usdcDecimals),
          },
        },
        changes: {
          asset: {
            raw: (testerBalanceAfter1.asset - testerBalanceBefore1.asset).toString(),
            formatted: ethers.formatUnits(testerBalanceAfter1.asset - testerBalanceBefore1.asset, assetDecimals),
          },
          usdc: {
            raw: (testerBalanceAfter1.usdc - testerBalanceBefore1.usdc).toString(),
            formatted: ethers.formatUnits(testerBalanceAfter1.usdc - testerBalanceBefore1.usdc, usdcDecimals),
          },
        },
      },
      hopExecuted: hopEvents1.map((e, i) => ({
        hop: i,
        pool: e.pool,
        direction: e.assetToUsdc ? "ASSET→USDC" : "USDC→ASSET",
        amountIn: {
          raw: e.amountIn,
          formatted: ethers.formatUnits(e.amountIn, e.assetToUsdc ? assetDecimals : usdcDecimals),
        },
        amountOut: {
          raw: e.amountOut,
          formatted: ethers.formatUnits(e.amountOut, e.assetToUsdc ? usdcDecimals : assetDecimals),
        },
        tokenIn: e.tokenIn,
        tokenOut: e.tokenOut,
      })),
    };
    
    results.swaps.push(swap1Snapshot);
    
  } catch (error: any) {
    console.error(`   ❌ Swap 1 failed: ${error.message}`);
    results.swaps.push({
      swap: "0.02 USDC → cbBTC (POS orbit)",
      error: error.message,
    });
  }
  
  // Wait a bit between swaps
  console.log("Waiting 5 seconds before next swap...\n");
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Test 2: 0.0000002 cbBTC → USDC (NEG orbit)
  console.log("=== Swap 2: 0.0000002 cbBTC → USDC (NEG orbit) ===");
  const amountCBBTC = ethers.parseUnits("0.0000002", assetDecimals);
  const startPool2 = pools.pool0.address; // NEG orbit pool
  
  try {
    // Get quote (like MEV bots do)
    let assetToUsdc2: boolean, orbit2: string[], perHop2: bigint[], total2: bigint;
    let totalInputCost2: bigint, totalFees2: bigint;
    
    try {
      // Try new function first
      [assetToUsdc2, orbit2, perHop2, total2, totalInputCost2, totalFees2] = await router.getAmountsOutFromStartWithCost(
        startPool2,
        amountCBBTC,
        true // useNegOrbit = true (ASSET→USDC, NEG orbit)
      );
    } catch {
      // Fallback: use old function and calculate cost manually
      [assetToUsdc2, orbit2, perHop2, total2] = await router.getAmountsOutFromStartWithDirection(
        startPool2,
        amountCBBTC,
        true
      );
      const MCV_FEE_BPS = 120n;
      const BPS_DENOMINATOR = 10000n;
      const numHops = BigInt(orbit2.length);
      const feePerHop = (amountCBBTC * MCV_FEE_BPS) / BPS_DENOMINATOR;
      totalFees2 = feePerHop * numHops;
      totalInputCost2 = (amountCBBTC * numHops) + totalFees2;
    }
    
    console.log(`   Quote: ${ethers.formatUnits(amountCBBTC, assetDecimals)} cbBTC → ${ethers.formatUnits(total2, usdcDecimals)} USDC`);
    console.log(`   Total Cost: ${ethers.formatUnits(totalInputCost2, assetDecimals)} cbBTC`);
    console.log(`   Orbit: ${orbit2.length} pools (NEG)`);
    orbit2.forEach((p, i) => console.log(`     Pool ${i}: ${p}`));
    console.log("");
    
    // Get state BEFORE
    console.log("   Getting pool state BEFORE swap...");
    const poolsBefore2 = await getAllPoolsState();
    const testerBalanceBefore2 = {
      asset: await asset.balanceOf(testerAddress),
      usdc: await usdc.balanceOf(testerAddress),
    };
    
    // Set up approvals
    console.log("   Setting up approvals...");
    await approveMax(asset, tester, routerAddr);
    for (const poolAddr of orbit2) {
      await approveMax(asset, tester, poolAddr);
    }
    console.log("   ✓ Approvals set");
    
    // Execute swap
    console.log("   Executing swap...");
    const swapParams2 = {
      startPool: startPool2,
      assetToUsdc: true, // NEG orbit (ASSET→USDC)
      amountIn: amountCBBTC,
      minTotalAmountOut: 0n,
      to: testerAddress,
      payer: testerAddress,
    };
    
    const tx2 = await router.swap(swapParams2);
    console.log(`   ✓ Transaction sent: ${tx2.hash}`);
    console.log(`   View on BaseScan: https://basescan.org/tx/${tx2.hash}`);
    
    const receipt2 = await tx2.wait();
    if (!receipt2 || receipt2.status !== 1) {
      throw new Error(`Swap failed. Status: ${receipt2?.status}`);
    }
    
    // Get state AFTER
    console.log("   Getting pool state AFTER swap...");
    const poolsAfter2 = await getAllPoolsState();
    const testerBalanceAfter2 = {
      asset: await asset.balanceOf(testerAddress),
      usdc: await usdc.balanceOf(testerAddress),
    };
    
    // Parse HopExecuted events
    const HopExecutedSig = ethers.id("HopExecuted(address,bool,address,address,uint256,uint256)");
    const hopEvents2 = (receipt2.logs ?? [])
      .filter((l: any) => l.topics && l.topics[0] === HopExecutedSig)
      .map((l: any) => {
        const pool = ethers.getAddress("0x" + l.topics[1].slice(26));
        const tokenIn = ethers.getAddress("0x" + l.topics[2].slice(26));
        const tokenOut = ethers.getAddress("0x" + l.topics[3].slice(26));
        const [assetToUsdc, amtIn, amtOut] = ethers.AbiCoder.defaultAbiCoder().decode(
          ["bool", "uint256", "uint256"],
          l.data
        );
        return {
          pool,
          assetToUsdc: Boolean(assetToUsdc),
          amountIn: amtIn.toString(),
          amountOut: amtOut.toString(),
          tokenIn,
          tokenOut,
        };
      });
    
    // Parse OffsetFlipped events (event OffsetFlipped(int16 newOffset) - no indexed params)
    const OffsetFlippedSig = ethers.id("OffsetFlipped(int16)");
    const offsetFlippedEvents2 = (receipt2.logs ?? [])
      .filter((l: any) => l.topics && l.topics[0] === OffsetFlippedSig)
      .map((l: any) => {
        const [newOffset] = ethers.AbiCoder.defaultAbiCoder().decode(["int16"], l.data);
        return {
          pool: l.address, // Event emitted by pool contract
          newOffset: Number(newOffset),
        };
      });
    
    console.log(`   ✓ Swap completed. ${hopEvents2.length} hops executed`);
    if (offsetFlippedEvents2.length > 0) {
      console.log(`   ✓ Offset flipped for ${offsetFlippedEvents2.length} pools`);
      offsetFlippedEvents2.forEach((e: any) => {
        console.log(`     Pool ${e.pool}: offset → ${e.newOffset}`);
      });
    }
    console.log("");
    
    // Build snapshot entry
    const swap2Snapshot: any = {
      swap: "0.0000002 cbBTC → USDC (NEG orbit)",
      input: {
        amount: ethers.formatUnits(amountCBBTC, assetDecimals),
        token: "cbBTC",
        decimals: assetDecimals,
        raw: amountCBBTC.toString(),
      },
      quote: {
        totalOutput: ethers.formatUnits(total2, usdcDecimals),
        totalCost: ethers.formatUnits(totalInputCost2, assetDecimals),
        totalFees: ethers.formatUnits(totalFees2, assetDecimals),
        orbit: orbit2,
        perHopOutputs: perHop2.map((amt, i) => ({
          hop: i,
          amount: ethers.formatUnits(amt, usdcDecimals),
          raw: amt.toString(),
        })),
      },
      transaction: {
        hash: tx2.hash,
        blockNumber: receipt2.blockNumber,
        gasUsed: receipt2.gasUsed.toString(),
        baseScanUrl: `https://basescan.org/tx/${tx2.hash}`,
      },
      pools: {
        before: poolsBefore2,
        after: poolsAfter2,
        offsetChanges: {
          pool0: {
            before: poolsBefore2.pool0.targetOffsetBps,
            after: poolsAfter2.pool0.targetOffsetBps,
            flipped: poolsBefore2.pool0.targetOffsetBps !== poolsAfter2.pool0.targetOffsetBps,
          },
          pool1: {
            before: poolsBefore2.pool1.targetOffsetBps,
            after: poolsAfter2.pool1.targetOffsetBps,
            flipped: poolsBefore2.pool1.targetOffsetBps !== poolsAfter2.pool1.targetOffsetBps,
          },
          pool2: {
            before: poolsBefore2.pool2.targetOffsetBps,
            after: poolsAfter2.pool2.targetOffsetBps,
            flipped: poolsBefore2.pool2.targetOffsetBps !== poolsAfter2.pool2.targetOffsetBps,
          },
          pool3: {
            before: poolsBefore2.pool3.targetOffsetBps,
            after: poolsAfter2.pool3.targetOffsetBps,
            flipped: poolsBefore2.pool3.targetOffsetBps !== poolsAfter2.pool3.targetOffsetBps,
          },
        },
      },
      offsetFlippedEvents: offsetFlippedEvents2,
      testerBalances: {
        before: {
          asset: {
            raw: testerBalanceBefore2.asset.toString(),
            formatted: ethers.formatUnits(testerBalanceBefore2.asset, assetDecimals),
          },
          usdc: {
            raw: testerBalanceBefore2.usdc.toString(),
            formatted: ethers.formatUnits(testerBalanceBefore2.usdc, usdcDecimals),
          },
        },
        after: {
          asset: {
            raw: testerBalanceAfter2.asset.toString(),
            formatted: ethers.formatUnits(testerBalanceAfter2.asset, assetDecimals),
          },
          usdc: {
            raw: testerBalanceAfter2.usdc.toString(),
            formatted: ethers.formatUnits(testerBalanceAfter2.usdc, usdcDecimals),
          },
        },
        changes: {
          asset: {
            raw: (testerBalanceAfter2.asset - testerBalanceBefore2.asset).toString(),
            formatted: ethers.formatUnits(testerBalanceAfter2.asset - testerBalanceBefore2.asset, assetDecimals),
          },
          usdc: {
            raw: (testerBalanceAfter2.usdc - testerBalanceBefore2.usdc).toString(),
            formatted: ethers.formatUnits(testerBalanceAfter2.usdc - testerBalanceBefore2.usdc, usdcDecimals),
          },
        },
      },
      hopExecuted: hopEvents2.map((e, i) => ({
        hop: i,
        pool: e.pool,
        direction: e.assetToUsdc ? "ASSET→USDC" : "USDC→ASSET",
        amountIn: {
          raw: e.amountIn,
          formatted: ethers.formatUnits(e.amountIn, e.assetToUsdc ? assetDecimals : usdcDecimals),
        },
        amountOut: {
          raw: e.amountOut,
          formatted: ethers.formatUnits(e.amountOut, e.assetToUsdc ? usdcDecimals : assetDecimals),
        },
        tokenIn: e.tokenIn,
        tokenOut: e.tokenOut,
      })),
    };
    
    results.swaps.push(swap2Snapshot);
    
  } catch (error: any) {
    console.error(`   ❌ Swap 2 failed: ${error.message}`);
    results.swaps.push({
      swap: "0.0000002 cbBTC → USDC (NEG orbit)",
      error: error.message,
    });
  }
  
  // Save snapshot in pool-manifest.json format
  const snapshotDir = path.join(process.cwd(), "test", "MEV", "test", "__snapshots__");
  if (!fs.existsSync(snapshotDir)) {
    fs.mkdirSync(snapshotDir, { recursive: true });
  }
  
  // Create pool-manifest format snapshot
  const poolManifestSnapshot: any = {
    swaps: results.swaps.map((s: any) => {
      if (s.error) return s;
      
      // Get pool info in pool-manifest format
      const poolInfo: any = {};
      const allPools = [pools.pool0, pools.pool1, pools.pool2, pools.pool3];
      
      for (let i = 0; i < 4; i++) {
        const poolAddr = allPools[i].address;
        const before = s.pools.before[`pool${i}`];
        const after = s.pools.after[`pool${i}`];
        
        poolInfo[`pool${i}`] = {
          address: poolAddr,
          orbit: allPools[i].orbit,
          offsetBefore: before.targetOffsetBps,
          offsetAfter: after.targetOffsetBps,
          offsetFlipped: before.targetOffsetBps !== after.targetOffsetBps,
          initialized: true,
          reserves: {
            ASSET: {
              raw: after.reserveAsset.raw,
              formatted: after.reserveAsset.formatted,
            },
            USDC: {
              raw: after.reserveUsdc.raw,
              formatted: after.reserveUsdc.formatted,
            },
          },
          price: {
            before: {
              priceX96: before.priceX96,
              price: before.price,
            },
            after: {
              priceX96: after.priceX96,
              price: after.price,
            },
            change: {
              priceX96: (BigInt(after.priceX96) - BigInt(before.priceX96)).toString(),
              price: (Number(after.price) - Number(before.price)).toFixed(2),
              percentChange: before.price !== "0" && before.price !== "0.00" 
                ? (((Number(after.price) - Number(before.price)) / Number(before.price)) * 100).toFixed(4) + "%"
                : "0.0000%",
            },
          },
          router: routerAddr.toLowerCase(),
          changes: {
            ASSET: {
              raw: (BigInt(after.reserveAsset.raw) - BigInt(before.reserveAsset.raw)).toString(),
              formatted: ethers.formatUnits(
                BigInt(after.reserveAsset.raw) - BigInt(before.reserveAsset.raw),
                assetDecimals
              ),
            },
            USDC: {
              raw: (BigInt(after.reserveUsdc.raw) - BigInt(before.reserveUsdc.raw)).toString(),
              formatted: ethers.formatUnits(
                BigInt(after.reserveUsdc.raw) - BigInt(before.reserveUsdc.raw),
                usdcDecimals
              ),
            },
          },
        };
      }
      
      return {
        swap: s.swap,
        input: s.input,
        quote: s.quote,
        transaction: s.transaction,
        pools: poolInfo,
        hopExecuted: s.hopExecuted,
        testerBalances: s.testerBalances,
      };
    }),
    tokens: {
      ASSET: {
        address: assetAddr,
        symbol: "cbBTC",
        decimals: assetDecimals.toString(),
      },
      USDC: {
        address: usdcAddr,
        symbol: "USDC",
        decimals: usdcDecimals.toString(),
      },
    },
    topology: manifest.topology,
    createdAt: new Date().toISOString(),
  };
  
  // Helper to convert BigInt to string recursively
  function bigIntToString(obj: any): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === "bigint") return obj.toString();
    if (Array.isArray(obj)) return obj.map(bigIntToString);
    if (typeof obj === "object") {
      const result: any = {};
      for (const key in obj) {
        result[key] = bigIntToString(obj[key]);
      }
      return result;
    }
    return obj;
  }
  
  const snapshotPath = path.join(snapshotDir, "mainnet-swaps.snap.json");
  fs.writeFileSync(snapshotPath, JSON.stringify(bigIntToString(poolManifestSnapshot), null, 2));
  
  console.log("\n=== Swap Test Complete ===");
  console.log(`Snapshot saved to: ${snapshotPath}`);
  console.log(`Total swaps executed: ${results.swaps.filter((s: any) => !s.error).length}`);
  console.log(`Total swaps failed: ${results.swaps.filter((s: any) => s.error).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

