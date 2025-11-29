import fs from "node:fs";
import path from "node:path";
import { Mispricing } from "../types";

export interface AggregatedOpportunity {
  pairId: string;
  borrowToken: string;
  buyVenue: string;
  sellVenue: string;
  loanAprBps?: number;
  loanDurationHours?: number;
  netProfitUsd: number;
  isProfitable: boolean;
  expectedProfitUsd: number;
  timestamp: number;
}

export interface DashboardSummary {
  generatedAt: number;
  totals: {
    opportunities: number;
    profitable: number;
  };
  topOpportunities: AggregatedOpportunity[];
}

export function buildDashboardSummary(
  mispricings: Mispricing[],
  opts: { limit?: number } = {}
): DashboardSummary {
  const limit = opts.limit ?? 10;
  const entries: AggregatedOpportunity[] = mispricings
    .map((m) => ({
      pairId: m.pairId,
      borrowToken: m.borrowToken,
      buyVenue: m.buyVenue,
      sellVenue: m.sellVenue,
      loanAprBps: undefined,
      loanDurationHours: 1,
      netProfitUsd: Number(m.expectedProfitUsd.toFixed(2)),
      expectedProfitUsd: Number(m.expectedProfitUsd.toFixed(2)),
      isProfitable: m.expectedProfitUsd >= 0,
      timestamp: Date.now(),
    }))
    .sort((a, b) => b.netProfitUsd - a.netProfitUsd)
    .slice(0, limit);

  return {
    generatedAt: Date.now(),
    totals: {
      opportunities: mispricings.length,
      profitable: mispricings.filter((m) => m.expectedProfitUsd >= 0).length,
    },
    topOpportunities: entries,
  };
}

export function writeDashboardSummary(
  summary: DashboardSummary,
  outputDir: string
) {
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, "summary.json");
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
  return file;
}

