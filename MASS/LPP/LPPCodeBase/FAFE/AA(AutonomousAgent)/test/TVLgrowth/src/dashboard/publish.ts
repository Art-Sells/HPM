import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildDashboardSummary, writeDashboardSummary } from "./aggregator";
import { Mispricing, WatcherResult } from "../types";

export interface PublishOptions {
  logsDir: string;
  outputDir?: string;
  limit?: number;
}

export function loadWatcherResults(logDir: string): WatcherResult[] {
  if (!fs.existsSync(logDir)) {
    return [];
  }
  const files = fs
    .readdirSync(logDir)
    .filter((file) => file.endsWith(".ndjson"))
    .sort();

  const results: WatcherResult[] = [];
  for (const file of files) {
    const fullPath = path.join(logDir, file);
    const contents = fs.readFileSync(fullPath, "utf8");
    contents
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        try {
          const parsed = JSON.parse(line) as WatcherResult;
          results.push(parsed);
        } catch (err) {
          console.warn(`[dashboard] skipping malformed line in ${file}`, err);
        }
      });
  }
  return results;
}

export function flattenMispricings(results: WatcherResult[]): Mispricing[] {
  return results.flatMap((r) => r.mispricings);
}

export function publishDashboard(options: PublishOptions) {
  const logsDir = options.logsDir;
  const outputDir =
    options.outputDir ??
    path.join(os.tmpdir(), "tvl-dashboard", Date.now().toString());
  const results = loadWatcherResults(logsDir);
  const mispricings = flattenMispricings(results);
  const summary = buildDashboardSummary(mispricings, {
    limit: options.limit,
  });
  const filePath = writeDashboardSummary(summary, outputDir);
  return { filePath, summary };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const logsDir = args[0] ?? path.join(__dirname, "..", "logs", "tvl-growth");
  const outputDir = args[1];
  try {
    const { filePath, summary } = publishDashboard({ logsDir, outputDir });
    console.log(
      `[dashboard] wrote summary for ${summary.totals.opportunities} opportunities (${summary.totals.profitable} profitable) -> ${filePath}`
    );
  } catch (err) {
    console.error("[dashboard] failed to publish summary", err);
    process.exit(1);
  }
}

