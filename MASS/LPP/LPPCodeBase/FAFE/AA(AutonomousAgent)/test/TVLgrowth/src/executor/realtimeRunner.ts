import { ethers } from "ethers";

import { runWatcherOnce } from "../watcher";
import { Mispricing } from "../types";
import { getBaseProvider } from "../onchain/provider";
import { getTokenDecimals } from "../onchain/erc20";
import { fetchZeroExQuote } from "../execution/zeroEx";

const MIN_PROFIT_USD = Number(process.env.TVL_EXECUTOR_MIN_PROFIT_USD ?? "50");
const EXECUTION_INTERVAL_MS = Number(
  process.env.TVL_EXECUTOR_INTERVAL_MS ?? "10000"
);
const DRY_RUN = process.env.TVL_EXECUTOR_DRY_RUN !== "0";

// FAFE Router address (update with actual deployment)
const FAFE_ROUTER_ADDRESS =
  process.env.FAFE_ROUTER_ADDRESS ?? "0x6118FFE292EE599FE2b987FCE9668ea9EB5d7ea4";

// Token addresses
const USDC_ADDRESS = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA";
const CBETH_ADDRESS = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";

interface ExecutionPlan {
  mispricing: Mispricing;
  borrowAmount: bigint;
  buyTokenAddress: string;
  sellTokenAddress: string;
  buyAmount: bigint;
  sellAmount: bigint;
  expectedProfitUsd: number;
  gasEstimate: bigint;
  timestamp: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveTokenAddress(symbol: string): Promise<string | null> {
  const upper = symbol.toUpperCase();
  if (upper === "USDC" || upper === "USDBC") return USDC_ADDRESS;
  if (upper === "ASSET" || upper === "CBETH") return CBETH_ADDRESS;
  // Add more mappings as needed
  return null;
}

async function buildExecutionPlan(
  mispricing: Mispricing
): Promise<ExecutionPlan | null> {
  const provider = getBaseProvider();
  if (!provider) {
    console.error("[executor] No Base RPC provider available");
    return null;
  }

  // Resolve token addresses
  const borrowTokenAddr = await resolveTokenAddress(mispricing.borrowToken);
  if (!borrowTokenAddr) {
    console.warn(
      `[executor] Cannot resolve borrow token: ${mispricing.borrowToken}`
    );
    return null;
  }

  // Determine buy/sell tokens based on direction
  const [base, quote] = mispricing.pairId.split("/");
  const isBorrowingBase = mispricing.borrowToken.toUpperCase() === base.toUpperCase();
  
  const buyTokenAddr = isBorrowingBase
    ? await resolveTokenAddress(quote)
    : await resolveTokenAddress(base);
  const sellTokenAddr = isBorrowingBase
    ? await resolveTokenAddress(base)
    : await resolveTokenAddress(quote);

  if (!buyTokenAddr || !sellTokenAddr) {
    console.warn(`[executor] Cannot resolve token addresses for ${mispricing.pairId}`);
    return null;
  }

  // Get token decimals
  const borrowDecimals = await getTokenDecimals(borrowTokenAddr);
  const buyDecimals = await getTokenDecimals(buyTokenAddr);
  const sellDecimals = await getTokenDecimals(sellTokenAddr);

  if (!borrowDecimals || !buyDecimals || !sellDecimals) {
    console.warn("[executor] Failed to get token decimals");
    return null;
  }

  // Calculate borrow amount (use recommended size or default)
  const borrowAmountTokens = mispricing.recommendedSize || 1000;
  const borrowAmount = ethers.parseUnits(
    borrowAmountTokens.toFixed(borrowDecimals),
    borrowDecimals
  );

  // Get quote for buy leg (borrow -> buy token)
  const buyQuote = await fetchZeroExQuote({
    sellToken: borrowTokenAddr,
    buyToken: buyTokenAddr,
    sellAmount: borrowAmount,
  });

  if (!buyQuote) {
    console.warn("[executor] Failed to get buy quote");
    return null;
  }

  const buyAmount = buyQuote.buyAmount;

  // Get quote for sell leg (sell token -> repay token)
  const sellQuote = await fetchZeroExQuote({
    sellToken: sellTokenAddr,
    buyToken: borrowTokenAddr,
    sellAmount: buyAmount,
  });

  if (!sellQuote) {
    console.warn("[executor] Failed to get sell quote");
    return null;
  }

  const sellAmount = sellQuote.buyAmount;
  const gasEstimate = buyQuote.estimatedGas + sellQuote.estimatedGas;

  return {
    mispricing,
    borrowAmount,
    buyTokenAddress: buyTokenAddr,
    sellTokenAddress: sellTokenAddr,
    buyAmount,
    sellAmount,
    expectedProfitUsd: mispricing.expectedProfitUsd,
    gasEstimate,
    timestamp: Date.now(),
  };
}

async function executeOpportunity(plan: ExecutionPlan): Promise<boolean> {
  if (DRY_RUN) {
    console.log("\n" + "=".repeat(80));
    console.log("🚀 EXECUTION PLAN (DRY RUN)");
    console.log("=".repeat(80));
    console.log(`Pair: ${plan.mispricing.pairId}`);
    console.log(`Borrow Token: ${plan.mispricing.borrowToken}`);
    console.log(`Strategy: Buy on ${plan.mispricing.buyVenue}, Sell on ${plan.mispricing.sellVenue}`);
    console.log(`Borrow Amount: ${ethers.formatEther(plan.borrowAmount)} ${plan.mispricing.borrowToken}`);
    console.log(`Expected Profit: $${plan.expectedProfitUsd.toFixed(2)}`);
    console.log(`Edge: ${plan.mispricing.edgeBps.toFixed(1)} bps`);
    console.log(`Gas Estimate: ${plan.gasEstimate.toString()}`);
    console.log("=".repeat(80) + "\n");
    return true;
  }

  // TODO: Implement actual on-chain execution
  // 1. Flash loan from Aave
  // 2. Execute buy trade via 0x
  // 3. Execute sell trade via 0x
  // 4. Repay flash loan
  // 5. Deposit profit to FAFE pool
  console.warn("[executor] Real execution not yet implemented");
  return false;
}

export async function runRealtimeExecutor(options: {
  minProfitUsd?: number;
  intervalMs?: number;
  maxIterations?: number;
}): Promise<void> {
  const minProfit = options.minProfitUsd ?? MIN_PROFIT_USD;
  const interval = options.intervalMs ?? EXECUTION_INTERVAL_MS;
  const maxIterations = options.maxIterations;

  console.log("=".repeat(80));
  console.log("⚡ REAL-TIME TVL EXECUTOR");
  console.log("=".repeat(80));
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (simulation only)" : "LIVE (on-chain execution)"}`);
  console.log(`Min Profit Threshold: $${minProfit}`);
  console.log(`Scan Interval: ${interval / 1000}s`);
  console.log(`FAFE Router: ${FAFE_ROUTER_ADDRESS}`);
  console.log("=".repeat(80) + "\n");

  let iteration = 0;
  let totalOpportunities = 0;
  let executedCount = 0;

  while (maxIterations === undefined || iteration < maxIterations) {
    iteration++;
    const startTime = Date.now();

    try {
      const localTime = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
      console.log(
        `[${localTime} PST] Iteration ${iteration}: Scanning for opportunities...`
      );

      // Scan top 10 pairs by liquidity for maximum opportunity discovery
      const result = await runWatcherOnce({
        dynamicPairs: true, // Use dynamic discovery to find top liquidity pairs
        logDir: null, // Don't log during real-time execution
      });

      const uniquePairs = Array.from(new Set(result.quotes.map(q => q.pairId)));
      const venues = Array.from(new Set(result.quotes.map(q => {
        const venue = q.venueId || 'unknown';
        // Extract DEX name from venue ID (e.g., "uniswap:0x..." -> "uniswap")
        return venue.split(':')[0];
      })));
      
      console.log(`   Scanned ${result.quotes.length} quotes across ${uniquePairs.length} pairs: ${uniquePairs.slice(0, 5).join(', ')}${uniquePairs.length > 5 ? ` (+${uniquePairs.length - 5} more)` : ''}`);
      console.log(`   Venues: ${venues.join(', ')}`);
      console.log(`   Loan quotes available: ${result.loanQuotes.length} (${result.loanQuotes.map(l => l.asset).join(', ')})`);
      console.log(`   Found ${result.mispricings.length} total opportunities (before profit filter)`);
      
      // Show breakdown by venue pairs (Uniswap vs Aerodrome specifically)
      const uniswapAerodromeOpps = result.mispricings.filter(m => 
        (m.buyVenue.includes('uniswap') || m.buyVenue.includes('aerodrome')) &&
        (m.sellVenue.includes('uniswap') || m.sellVenue.includes('aerodrome'))
      );
      if (uniswapAerodromeOpps.length > 0) {
        console.log(`   Uniswap/Aerodrome opportunities: ${uniswapAerodromeOpps.length}`);
      }
      
      if (result.mispricings.length > 0) {
        const profits = result.mispricings.map(m => m.expectedProfitUsd);
        console.log(`   Profit range: $${Math.min(...profits).toFixed(2)} - $${Math.max(...profits).toFixed(2)}`);
      }

      const profitable = result.mispricings.filter(
        (m) => m.expectedProfitUsd >= minProfit
      );

      totalOpportunities += profitable.length;

      if (profitable.length > 0) {
        console.log(
          `\n✅ Found ${profitable.length} profitable opportunity(ies) above $${minProfit} threshold`
        );

        // Sort by profit (highest first)
        const sorted = profitable.sort(
          (a, b) => b.expectedProfitUsd - a.expectedProfitUsd
        );

        for (const opp of sorted) {
          console.log(
            `  - ${opp.pairId} | ${opp.borrowToken} | $${opp.expectedProfitUsd.toFixed(2)} profit | ${opp.edgeBps.toFixed(1)} bps edge`
          );

          const plan = await buildExecutionPlan(opp);
          if (plan) {
            const executed = await executeOpportunity(plan);
            if (executed) {
              executedCount++;
            }
          }
        }
      } else {
        console.log(`   No opportunities found (${result.mispricings.length} total, all below threshold)`);
      }

      const elapsed = Date.now() - startTime;
      const sleepTime = Math.max(0, interval - elapsed);
      
      if (sleepTime > 0) {
        await sleep(sleepTime);
      }
    } catch (error) {
      console.error(`[executor] Error in iteration ${iteration}:`, error);
      await sleep(interval);
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("📊 EXECUTION SUMMARY");
  console.log("=".repeat(80));
  console.log(`Total Iterations: ${iteration}`);
  console.log(`Total Opportunities Found: ${totalOpportunities}`);
  console.log(`Executed: ${executedCount}`);
  console.log("=".repeat(80) + "\n");
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const maxIterations = args[0] ? Number(args[0]) : undefined;
  const minProfit = args[1] ? Number(args[1]) : undefined;
  const interval = args[2] ? Number(args[2]) : undefined;

  runRealtimeExecutor({
    minProfitUsd: minProfit,
    intervalMs: interval,
    maxIterations,
  })
    .then(() => {
      console.log("[executor] Shutdown complete");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[executor] Fatal error:", err);
      process.exit(1);
    });
}

