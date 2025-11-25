// scripts/monitor-events.ts
// Monitor LPP Router events on Base mainnet
//
// Usage:
//   npx hardhat run scripts/monitor-events.ts --network base
//
// This script monitors the following events:
//   - HopExecuted
//   - OrbitFlipped
//   - FeeTaken
//   - DailyEventCapUpdated
//   - DailyEventWindowRolled

import hre from "hardhat";
const { ethers } = hre;
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
dotenv.config();

async function main() {
  const provider = ethers.provider;
  
  // Load router address from deployment manifest
  const manifestPath = path.join(process.cwd(), "deployment-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("deployment-manifest.json not found. Run deployment first.");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const routerAddr = manifest.contracts.LPPRouter;
  
  console.log("=== LPP Router Event Monitor ===");
  console.log("Router:", routerAddr);
  console.log("Network:", (await provider.getNetwork()).name);
  console.log("Chain ID:", (await provider.getNetwork()).chainId);
  console.log("\nMonitoring events... (Press Ctrl+C to stop)\n");
  
  const RouterFactory = await ethers.getContractFactory("LPPRouter");
  const router = RouterFactory.attach(routerAddr).connect(provider);
  
  // Get current block
  let lastCheckedBlock = await provider.getBlockNumber();
  console.log(`Starting from block: ${lastCheckedBlock}`);
  console.log(`View on BaseScan: https://basescan.org/address/${routerAddr}\n`);
  console.log("Polling for events every 12 seconds...\n");
  
  // Track seen events to avoid duplicates
  const seenEvents = new Set<string>();
  
  // Poll for events
  const pollInterval = setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();
      
      // Check for new events in the last few blocks (check last 5 blocks to catch any we might have missed)
      const fromBlock = Math.max(lastCheckedBlock - 4, 0);
      const toBlock = currentBlock;
      
      if (fromBlock <= toBlock) {
        // Query HopExecuted events
        const hopFilter = router.filters.HopExecuted();
        const hopEvents = await router.queryFilter(hopFilter, fromBlock, toBlock);
        
        for (const event of hopEvents) {
          const eventKey = `hop-${event.blockNumber}-${event.index}`;
          if (!seenEvents.has(eventKey)) {
            seenEvents.add(eventKey);
            console.log(`[${event.blockNumber}] HopExecuted:`);
            console.log(`  Pool: ${event.args.pool}`);
            console.log(`  Direction: ${event.args.assetToUsdc ? "ASSET→USDC" : "USDC→ASSET"}`);
            console.log(`  Amount In: ${ethers.formatUnits(event.args.amountIn, 18)}`);
            console.log(`  Amount Out: ${ethers.formatUnits(event.args.amountOut, 18)}`);
            console.log(`  TX: https://basescan.org/tx/${event.transactionHash}\n`);
          }
        }
        
        // Query OrbitFlipped events
        const orbitFilter = router.filters.OrbitFlipped();
        const orbitEvents = await router.queryFilter(orbitFilter, fromBlock, toBlock);
        
        for (const event of orbitEvents) {
          const eventKey = `orbit-${event.blockNumber}-${event.index}`;
          if (!seenEvents.has(eventKey)) {
            seenEvents.add(eventKey);
            console.log(`[${event.blockNumber}] OrbitFlipped:`);
            console.log(`  Start Pool: ${event.args.startPool}`);
            console.log(`  Orbit Used: ${event.args.usedNegOrbit ? "NEG" : "POS"}`);
            console.log(`  TX: https://basescan.org/tx/${event.transactionHash}\n`);
          }
        }
        
        // Query FeeTaken events
        const feeFilter = router.filters.FeeTaken();
        const feeEvents = await router.queryFilter(feeFilter, fromBlock, toBlock);
        
        for (const event of feeEvents) {
          const eventKey = `fee-${event.blockNumber}-${event.index}`;
          if (!seenEvents.has(eventKey)) {
            seenEvents.add(eventKey);
            console.log(`[${event.blockNumber}] FeeTaken:`);
            console.log(`  Pool: ${event.args.pool}`);
            console.log(`  Total Fee: ${ethers.formatUnits(event.args.totalFee, 18)}`);
            console.log(`  Treasury Cut: ${ethers.formatUnits(event.args.treasuryCut, 18)}`);
            console.log(`  Pools Cut: ${ethers.formatUnits(event.args.poolsCut, 18)}`);
            console.log(`  TX: https://basescan.org/tx/${event.transactionHash}\n`);
          }
        }
        
        // Query DailyEventCapUpdated events
        const capFilter = router.filters.DailyEventCapUpdated();
        const capEvents = await router.queryFilter(capFilter, fromBlock, toBlock);
        
        for (const event of capEvents) {
          const eventKey = `cap-${event.blockNumber}-${event.index}`;
          if (!seenEvents.has(eventKey)) {
            seenEvents.add(eventKey);
            console.log(`[${event.blockNumber}] DailyEventCapUpdated: ${event.args.newCap}`);
            console.log(`  TX: https://basescan.org/tx/${event.transactionHash}\n`);
          }
        }
        
        // Query DailyEventWindowRolled events
        const windowFilter = router.filters.DailyEventWindowRolled();
        const windowEvents = await router.queryFilter(windowFilter, fromBlock, toBlock);
        
        for (const event of windowEvents) {
          const eventKey = `window-${event.blockNumber}-${event.index}`;
          if (!seenEvents.has(eventKey)) {
            seenEvents.add(eventKey);
            console.log(`[${event.blockNumber}] DailyEventWindowRolled: Day ${event.args.dayIndex}`);
            console.log(`  TX: https://basescan.org/tx/${event.transactionHash}\n`);
          }
        }
      }
      
      lastCheckedBlock = currentBlock;
      
      // Check daily event window status
      const [day, count, cap] = await router.getDailyEventWindow();
      process.stdout.write(`\r[Status] Block: ${currentBlock} | Daily Events: ${count}/${cap} (Day ${day}) | Waiting for events...`);
      
    } catch (error: any) {
      console.error(`\nError polling events: ${error.message}`);
    }
  }, 12000); // Poll every 12 seconds (Base block time is ~2 seconds, so this catches new blocks)
  
  // Keep process alive
  process.on("SIGINT", () => {
    console.log("\n\nStopping monitor...");
    clearInterval(pollInterval);
    process.exit(0);
  });
  
  // Wait indefinitely
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

