import { strict as assert } from "node:assert";

import {
  loadDepthFixture,
  simulateArb,
} from "../../src/sim/arbitrage";

const mockOpp = {
  pairId: "ASSET/USDC",
  borrowToken: "USDC",
  buyVenue: "uniswap-v3",
  sellVenue: "aerodrome-v2",
  edgeBps: 500,
  expectedProfitUsd: 500,
  recommendedSize: 10_000,
  liquidityClass: "mid" as const,
};

describe("simulator slippage", () => {
  it("walks depth curves and adjusts profit", () => {
    const depth = loadDepthFixture("aset_usdc_depth.json");
    const result = simulateArb({
      opportunity: mockOpp,
      borrowSize: 5_000,
      depthCurve: depth,
    });
    assert.ok(result.borrowSize <= 5_000);
    assert.ok(result.netProfitUsd > 0);
  });
});

