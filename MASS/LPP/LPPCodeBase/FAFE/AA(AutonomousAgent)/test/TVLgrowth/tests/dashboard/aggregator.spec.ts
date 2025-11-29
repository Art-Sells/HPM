import { strict as assert } from "node:assert";

import { buildDashboardSummary } from "../../src/dashboard/aggregator";
import { Mispricing } from "../../src/types";

const sampleMispricings: Mispricing[] = [
  {
    pairId: "ASSET/USDC",
    borrowToken: "USDC",
    buyVenue: "uniswap-v3",
    sellVenue: "aerodrome-v2",
    edgeBps: 500,
    expectedProfitUsd: 200,
    recommendedSize: 4_000,
    liquidityClass: "mid",
  },
  {
    pairId: "cbBTC/USDC",
    borrowToken: "cbBTC",
    buyVenue: "aerodrome-v2",
    sellVenue: "uniswap-v3",
    edgeBps: -50,
    expectedProfitUsd: -20,
    recommendedSize: 0.1,
    liquidityClass: "mid",
  },
];

describe("dashboard aggregator", () => {
  it("computes totals and flags profitability", () => {
    const summary = buildDashboardSummary(sampleMispricings, { limit: 2 });
    assert.equal(summary.totals.opportunities, 2);
    assert.equal(summary.totals.profitable, 1);
    assert.equal(summary.topOpportunities.length, 2);
    assert.equal(summary.topOpportunities[0].isProfitable, true);
    assert.equal(summary.topOpportunities[1].isProfitable, false);
  });
});

