import { strict as assert } from "node:assert";

import { detectMispricings } from "../../src/detectors/mispricing";
import { DEFAULT_PAIRS } from "../../src/pairs";
import { getDefaultAdapters } from "../../src/adapters";
import { buildPlaybook } from "../../src/playbook/generator";
import { createExecutionStub } from "../utils/executionStub";
import { createSampleLoanQuotes } from "../utils/sampleLoans";

describe("playbook generator", () => {
  const originalDepth = process.env.TVL_WATCHER_DEPTH_MODE;

  before(() => {
    process.env.TVL_WATCHER_DEPTH_MODE = "mock";
  });

  after(() => {
    process.env.TVL_WATCHER_DEPTH_MODE = originalDepth;
  });

  it("produces ranked entries with rounded values", async () => {
    const quotes = (
      await Promise.all(
        getDefaultAdapters().map((adapter) => adapter.fetchQuotes(DEFAULT_PAIRS))
      )
    ).flat();
    const mispricings = await detectMispricings(
      quotes,
      DEFAULT_PAIRS,
      createSampleLoanQuotes(),
      {
        defaultTradeSize: 5_000,
        minProfitUsd: 0,
      },
      undefined,
      createExecutionStub()
    );
    const playbook = buildPlaybook(mispricings, 3);
    assert.equal(playbook.entries.length, Math.min(3, mispricings.length));
    playbook.entries.forEach((entry, idx) => {
      if (idx > 0) {
        assert.ok(
          playbook.entries[idx - 1].expectedProfitUsd >= entry.expectedProfitUsd,
          "sorted desc by profit"
        );
      }
    });
  });
});

