import fs from "node:fs";
import path from "node:path";

import { Mispricing } from "../types";

interface DepthLevel {
  price: number;
  size: number;
}

interface DepthCurve {
  levels: DepthLevel[];
  gasUsd: number;
}

export interface SimulationInput {
  opportunity: Mispricing;
  borrowSize: number; // units of borrow token
  depthCurve?: DepthCurve;
  slippageBps?: number;
  extraFeesUsd?: number;
  loanAprBps?: number;
  loanDurationHours?: number;
  borrowTokenPriceUsd?: number;
}

export interface SimulationResult {
  borrowSize: number;
  slippageBps: number;
  netProfitUsd: number;
  effectiveEdgeBps: number;
  passes: boolean;
}

export function simulateArb({
  opportunity,
  borrowSize,
  depthCurve,
  slippageBps = 15,
  extraFeesUsd = 0,
  loanAprBps,
  loanDurationHours = 1,
  borrowTokenPriceUsd,
}: SimulationInput): SimulationResult {
  let realizedProfit = scaleProfit(opportunity, borrowSize);
  let realizedBorrowSize = borrowSize;

  if (depthCurve) {
    const { executedSize, averagePriceUsd } = walkDepth(
      depthCurve,
      borrowSize
    );
    realizedBorrowSize = executedSize;
    realizedProfit =
      opportunity.expectedProfitUsd *
      (executedSize / opportunity.recommendedSize);
    slippageBps =
      opportunity.recommendedSize === 0
        ? 0
        : ((averagePriceUsd - opportunity.edgeBps) /
            opportunity.edgeBps) *
          10_000;
    extraFeesUsd += depthCurve.gasUsd;
  } else {
    const slippageFactor = 1 - slippageBps / 10_000;
    realizedProfit *= slippageFactor;
  }

  const loanCostTokens =
    loanAprBps && borrowSize > 0
      ? (borrowSize * loanAprBps * (loanDurationHours / (24 * 365))) / 10_000
      : 0;
  const loanCostUsd =
    borrowTokenPriceUsd !== undefined
      ? loanCostTokens * borrowTokenPriceUsd
      : loanCostTokens;

  const netProfit = realizedProfit - extraFeesUsd - loanCostUsd;
  const notionalUsd =
    borrowTokenPriceUsd !== undefined
      ? realizedBorrowSize * borrowTokenPriceUsd
      : realizedBorrowSize;
  const edgeBps =
    notionalUsd === 0 ? 0 : (netProfit / notionalUsd) * 10_000;

  return {
    borrowSize: realizedBorrowSize,
    slippageBps,
    netProfitUsd: netProfit,
    effectiveEdgeBps: edgeBps,
    passes: netProfit > 0 && edgeBps >= opportunity.edgeBps * 0.5,
  };
}

export function loadDepthFixture(name: string): DepthCurve {
  const fixturePath = path.resolve(
    __dirname,
    "..",
    "..",
    "fixtures",
    "depth",
    name
  );
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as DepthCurve;
}

function walkDepth(depth: DepthCurve, targetSize: number) {
  let remaining = targetSize;
  let executed = 0;
  let weightedPrice = 0;

  for (const level of depth.levels) {
    if (remaining <= 0) break;
    const size = Math.min(level.size, remaining);
    executed += size;
    weightedPrice += level.price * size;
    remaining -= size;
  }

  const averagePrice =
    executed > 0 ? weightedPrice / executed : 0;

  return {
    executedSize: executed,
    averagePriceUsd: averagePrice,
  };
}

function scaleProfit(opportunity: Mispricing, size: number) {
  if (opportunity.recommendedSize === 0) return 0;
  return (
    (opportunity.expectedProfitUsd / opportunity.recommendedSize) * size
  );
}

