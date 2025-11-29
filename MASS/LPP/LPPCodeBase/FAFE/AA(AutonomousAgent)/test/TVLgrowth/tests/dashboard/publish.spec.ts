import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";

import { publishDashboard } from "../../src/dashboard/publish";
import { WatcherResult } from "../../src/types";

function writeWatcherLog(dir: string, result: WatcherResult) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "watcher-2025-11-29.ndjson");
  fs.appendFileSync(file, JSON.stringify(result) + "\n", "utf8");
  return file;
}

describe("dashboard publish CLI", () => {
  it("aggregates watcher logs and writes summary", () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tvl-logs-"));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tvl-out-"));
    writeWatcherLog(logsDir, {
      timestamp: Date.now(),
      quotes: [],
      loanQuotes: [],
      mispricings: [
        {
          pairId: "ASSET/USDC",
          borrowToken: "USDC",
          buyVenue: "uniswap-v3",
          sellVenue: "aerodrome-v2",
          edgeBps: 120,
          expectedProfitUsd: 50,
          recommendedSize: 500,
          liquidityClass: "mid",
        },
      ],
    });
    writeWatcherLog(logsDir, {
      timestamp: Date.now(),
      quotes: [],
      loanQuotes: [],
      mispricings: [
        {
          pairId: "cbBTC/USDC",
          borrowToken: "cbBTC",
          buyVenue: "aerodrome-v2",
          sellVenue: "uniswap-v3",
          edgeBps: -30,
          expectedProfitUsd: -5,
          recommendedSize: 0.05,
          liquidityClass: "shallow",
        },
      ],
    });

    const { filePath, summary } = publishDashboard({
      logsDir,
      outputDir: outDir,
    });

    assert.ok(fs.existsSync(filePath));
    assert.equal(summary.totals.opportunities, 2);
    assert.equal(summary.totals.profitable, 1);

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(persisted.totals.profitable, 1);
  });
});

