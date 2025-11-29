import { strict as assert } from "node:assert";

import { DEFAULT_PAIRS } from "../src/pairs";
import { getDefaultAdapters } from "../src/adapters";
import { detectMispricings } from "../src/detectors/mispricing";

describe("TVLgrowth mispricing detector", () => {
  it("finds opportunities and ranks them by expected profit", async () => {
    const adapters = getDefaultAdapters();
    const quotes = (
      await Promise.all(adapters.map((adapter) => adapter.fetchQuotes(DEFAULT_PAIRS)))
    ).flat();
    const loanQuotes = [
      {
        lender: "mock",
        asset: "USDC",
        available: 1_000_000,
        aprBps: 50,
        maxDurationHours: 1,
        timestamp: Date.now(),
      },
      {
        lender: "mock",
        asset: "ASSET",
        available: 1_000_000,
        aprBps: 50,
        maxDurationHours: 1,
        timestamp: Date.now(),
      },
      {
        lender: "mock",
        asset: "cbBTC",
        available: 1_000_000,
        aprBps: 50,
        maxDurationHours: 1,
        timestamp: Date.now(),
      },
    ];

    const mispricings = detectMispricings(
      quotes,
      DEFAULT_PAIRS,
      loanQuotes,
      {
        minProfitUsd: 0,
        defaultTradeSize: 10_000,
        liquidityFraction: 1,
        minLiquidityUsd: 0,
        maxPriceRatio: 100,
        slippageBps: 0,
      }
    );

    assert.ok(mispricings.length > 0, "expected at least one opportunity");

    // Ensure sorted by expected profit desc
    for (let i = 1; i < mispricings.length; i++) {
      assert.ok(
        mispricings[i - 1].expectedProfitUsd >= mispricings[i].expectedProfitUsd,
        "mispricings should be sorted descending by profit"
      );
    }

    const top = mispricings[0];
    assert.ok(top.edgeBps > 0, "edge should be positive");
    assert.ok(top.expectedProfitUsd > 0, "profit should be positive");
    assert.ok(
      top.borrowToken === "USDC" || top.borrowToken === "ASSET" || top.borrowToken === "cbBTC",
      "borrow token should be recognized"
    );
  });
});

