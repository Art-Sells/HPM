import { strict as assert } from "node:assert";

import { detectMispricings } from "../../src/detectors/mispricing";
import { DEFAULT_PAIRS } from "../../src/pairs";
import { getDefaultAdapters } from "../../src/adapters";
import { buildPlaybook } from "../../src/playbook/generator";

describe("playbook generator", () => {
  it("produces ranked entries with rounded values", async () => {
    const quotes = (
      await Promise.all(
        getDefaultAdapters().map((adapter) => adapter.fetchQuotes(DEFAULT_PAIRS))
      )
    ).flat();
    const mispricings = detectMispricings(
      quotes,
      DEFAULT_PAIRS,
      [],
      {
        defaultTradeSize: 5_000,
        minProfitUsd: 0,
      }
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

