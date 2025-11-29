import fs from "node:fs";
import path from "node:path";

import { buildPlaybook, Playbook } from "./generator";
import { detectMispricings } from "../detectors/mispricing";
import { getDefaultAdapters } from "../adapters";
import { getActivePairs } from "../pairs";
import { loadLoanQuotes } from "../loan/loanFeed";
import {
  DetectionConfig,
  PairRequest,
  VenueAdapter,
} from "../types";

const DEFAULT_OUTPUT = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "strategies",
  "daily-playbook.json"
);

export interface PublishOptions {
  adapters?: VenueAdapter[];
  pairs?: PairRequest[];
  detector?: Partial<DetectionConfig>;
  limit?: number;
  outputPath?: string;
}

export async function buildAndWritePlaybook(
  options: PublishOptions = {}
): Promise<{ playbook: Playbook; outputPath: string }> {
  const adapters = options.adapters ?? getDefaultAdapters();
  const pairs = options.pairs ?? (await getActivePairs());
  const quotes = (
    await Promise.all(adapters.map((adapter) => adapter.fetchQuotes(pairs)))
  ).flat();

  const detectorCfg: DetectionConfig = {
    defaultTradeSize: 10_000,
    minProfitUsd: 0,
    liquidityFraction: 0.2,
    minLiquidityUsd: 50_000,
    maxPriceRatio: 3,
    slippageBps: 50,
    ...options.detector,
  };

  const loanQuotes = loadLoanQuotes();
  const mispricings = detectMispricings(
    quotes,
    pairs,
    loanQuotes,
    detectorCfg
  );
  const playbook = buildPlaybook(mispricings, options.limit ?? 10);
  const output = options.outputPath ?? DEFAULT_OUTPUT;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(playbook, null, 2));
  return { playbook, outputPath: output };
}

if (require.main === module) {
  buildAndWritePlaybook()
    .then(({ outputPath, playbook }) => {
      console.log(
        `[playbook] wrote ${playbook.entries.length} entries to ${outputPath}`
      );
    })
    .catch((err) => {
      console.error("[playbook] failed:", err);
      process.exit(1);
    });
}