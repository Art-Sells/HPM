import { strict as assert } from "node:assert";

import { DEFAULT_PAIRS } from "../../src/pairs";
import { uniswapMockAdapter } from "../../src/adapters/mock/uniswap";

describe("adapter: uniswap mock", () => {
  it("normalizes fixture quotes with venue metadata", async () => {
    const quotes = await uniswapMockAdapter.fetchQuotes(DEFAULT_PAIRS);
    assert.ok(quotes.length > 0, "should return quotes");
    quotes.forEach((quote) => {
      assert.equal(quote.venueId, "uniswap-v3");
      assert.ok(typeof quote.timestamp === "number");
      assert.ok(quote.amountIn > 0);
      assert.ok(quote.liquidityUsd > 0);
    });
  });
});

