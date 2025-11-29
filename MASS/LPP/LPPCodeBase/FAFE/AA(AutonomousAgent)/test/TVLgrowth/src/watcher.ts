import fs from "node:fs";
import path from "node:path";

import { getActivePairs } from "./pairs";
import { getDefaultAdapters } from "./adapters";
import { detectMispricings } from "./detectors/mispricing";
import { loadLoanQuotes } from "./loan/loanFeed";
import {
  DetectionConfig,
  LoanQuote,
  PairRequest,
  VenueAdapter,
  WatcherResult,
} from "./types";

const LOG_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "logs",
  "tvl-growth"
);

export const WATCHER_LOG_DIR = LOG_DIR;

const DETECTOR_CONFIG: DetectionConfig = {
  defaultTradeSize: 10_000,
  minProfitUsd: 0,
  liquidityFraction: 0.2,
  minLiquidityUsd: 50_000,
  maxPriceRatio: 3,
  slippageBps: 50,
};

export interface WatcherOptions {
  adapters?: VenueAdapter[];
  pairs?: PairRequest[];
  logDir?: string | null;
  detector?: Partial<DetectionConfig>;
  timestamp?: number;
  loanQuotes?: LoanQuote[];
  loanFeedPath?: string;
  dynamicPairs?: boolean;
}

export async function runWatcherOnce(
  options: WatcherOptions = {}
): Promise<WatcherResult> {
  const adapters = options.adapters ?? getDefaultAdapters();
  const pairs =
    options.pairs ?? (await getActivePairs({ dynamic: options.dynamicPairs }));
  const quotes = (
    await Promise.all(adapters.map((adapter) => adapter.fetchQuotes(pairs)))
  ).flat();

  const detectorCfg = { ...DETECTOR_CONFIG, ...options.detector };
  const loanQuotes =
    options.loanQuotes ??
    loadLoanQuotes({ filePath: options.loanFeedPath });
  const mispricings = detectMispricings(
    quotes,
    pairs,
    loanQuotes,
    detectorCfg
  );
  const timestamp = options.timestamp ?? Date.now();
  const result: WatcherResult = {
    timestamp,
    quotes,
    mispricings,
    loanQuotes,
  };

  const logDir =
    options.logDir === undefined ? LOG_DIR : options.logDir;
  if (logDir) {
    persistResult(result, logDir);
  }
  return result;
}

export function persistResult(result: WatcherResult, logDir: string) {
  fs.mkdirSync(logDir, { recursive: true });
  const filePath = path.join(
    logDir,
    `watcher-${new Date(result.timestamp).toISOString().slice(0, 10)}.ndjson`
  );
  fs.appendFileSync(filePath, JSON.stringify(result) + "\n", "utf8");
  return filePath;
}

if (require.main === module) {
  runWatcherOnce()
    .then((res) => {
      console.log(
        `[watcher] ${new Date(res.timestamp).toISOString()} – ${
          res.mispricings.length
        } opportunities (${res.loanQuotes.length} loan quotes)`
      );
      res.mispricings.slice(0, 5).forEach((opp) => {
        console.log(
          `  ${opp.pairId} ${opp.borrowToken} edge=${opp.edgeBps.toFixed(
            1
          )}bps profit≈$${opp.expectedProfitUsd.toFixed(2)}`
        );
      });
    })
    .catch((err) => {
      console.error("[watcher] error", err);
      process.exit(1);
    });
}

