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
import { loadLoanQuotes } from "../../src/loan/loanFeed";

describe("integration: playbook -> AA runner", () => {
  const originalDynamic = process.env.TVL_WATCHER_DYNAMIC;

  before(() => {
    process.env.TVL_WATCHER_DYNAMIC = "0";
  });

  after(() => {
    process.env.TVL_WATCHER_DYNAMIC = originalDynamic;
  });

  it("loads top entry and produces positive simulated profit", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-"));
    const tmpFile = path.join(tmpDir, "daily-playbook.json");

    try {
      await buildAndWritePlaybook({
        outputPath: tmpFile,
        detector: { defaultTradeSize: 4_000, minProfitUsd: 0 },
        limit: 3,
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
      const loanQuotes = loadLoanQuotes();
      const mispricings = detectMispricings(
        quotes,
        DEFAULT_PAIRS,
        loanQuotes,
        { defaultTradeSize: 4_000, minProfitUsd: 0 }
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
      });
      assert.ok(sim.passes, "AA trade should pass profitability gate");
      assert.ok(sim.netProfitUsd > 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

