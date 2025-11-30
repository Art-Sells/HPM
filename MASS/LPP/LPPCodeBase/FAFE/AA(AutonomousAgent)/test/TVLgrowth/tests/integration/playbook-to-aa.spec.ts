import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";

import { buildAndWritePlaybook } from "../../src/playbook/publisher";
import { loadPlaybookEntries } from "../../src/aa/playbookFeed";
import { getDefaultAdapters } from "../../src/adapters";
import { DEFAULT_PAIRS } from "../../src/pairs";
import { detectMispricings } from "../../src/detectors/mispricing";
import { simulateArb } from "../../src/sim/arbitrage";
import { createExecutionStub } from "../utils/executionStub";
import { createSampleLoanQuotes } from "../utils/sampleLoans";

describe("integration: playbook -> AA runner", () => {
  const originalDynamic = process.env.TVL_WATCHER_DYNAMIC;
  const originalOnchain = process.env.TVL_WATCHER_ONCHAIN;
  const originalFetchLoans = process.env.TVL_WATCHER_FETCH_AAVE;
  const originalDepth = process.env.TVL_WATCHER_DEPTH_MODE;

  before(() => {
    process.env.TVL_WATCHER_DYNAMIC = "0";
    process.env.TVL_WATCHER_ONCHAIN = "0";
    process.env.TVL_WATCHER_FETCH_AAVE = "0";
    process.env.TVL_WATCHER_DEPTH_MODE = "mock";
  });

  after(() => {
    process.env.TVL_WATCHER_DYNAMIC = originalDynamic;
    process.env.TVL_WATCHER_ONCHAIN = originalOnchain;
    process.env.TVL_WATCHER_FETCH_AAVE = originalFetchLoans;
    process.env.TVL_WATCHER_DEPTH_MODE = originalDepth;
  });

  it("loads top entry and produces positive simulated profit", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-"));
    const tmpFile = path.join(tmpDir, "daily-playbook.json");

    try {
      const execution = createExecutionStub();
      const loanQuotes = createSampleLoanQuotes();

      await buildAndWritePlaybook({
        outputPath: tmpFile,
        detector: { defaultTradeSize: 4_000, minProfitUsd: 0 },
        limit: 3,
        execution,
        loanQuotes,
      });

      const entries = loadPlaybookEntries({ filePath: tmpFile });
      assert.ok(entries.length > 0, "playbook should contain entries");

      const quotes = (
        await Promise.all(
          getDefaultAdapters().map((adapter) =>
            adapter.fetchQuotes(DEFAULT_PAIRS)
          )
        )
      ).flat();
      const mispricings = await detectMispricings(
        quotes,
        DEFAULT_PAIRS,
        loanQuotes,
        { defaultTradeSize: 4_000, minProfitUsd: 0 },
        undefined,
        execution
      );

      const top = entries[0];
      const match = mispricings.find(
        (m) =>
          m.pairId === top.pairId &&
          m.borrowToken === top.borrowToken &&
          m.buyVenue === top.buyVenue &&
          m.sellVenue === top.sellVenue
      );
      assert.ok(match, "playbook entry should map to mispricing");

      const loan = loanQuotes.find((l) => l.asset === top.borrowToken);

      const sim = simulateArb({
        opportunity: match!,
        borrowSize: top.recommendedSize,
        loanAprBps: loan?.aprBps,
        loanDurationHours: loan?.maxDurationHours,
        borrowTokenPriceUsd: 1,
      });
      assert.ok(sim.passes, "AA trade should pass profitability gate");
      assert.ok(sim.netProfitUsd > 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

