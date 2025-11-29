import { strict as assert } from "node:assert";

import {
  discoverDynamicPairs,
  getActivePairs,
  DEFAULT_PAIRS,
} from "../../src/pairs";

describe("pair discovery", () => {
  const realFetch = globalThis.fetch;

  const sampleResponse = {
    pairs: [
      {
        chainId: "base",
        pairAddress: "0x123",
        dexId: "uniswap",
        baseToken: { address: "0xaaa", symbol: "AAA", name: "AAA Token" },
        quoteToken: { address: "0xbbb", symbol: "BBB", name: "BBB Token" },
        liquidity: { usd: 1_000_000 },
      },
      {
        chainId: "base",
        pairAddress: "0x456",
        dexId: "aerodrome",
        baseToken: { address: "0xccc", symbol: "CCC", name: "CCC Token" },
        quoteToken: { address: "0xddd", symbol: "DDD", name: "DDD Token" },
        liquidity: { usd: 500_000 },
      },
    ],
  };

  beforeEach(() => {
    (globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => sampleResponse,
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.TVL_WATCHER_DYNAMIC;
  });

  it("discovers top base pairs sorted by liquidity", async () => {
    const pairs = await discoverDynamicPairs(2);
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0].pairAddress, "0x123");
    assert.equal(pairs[1].pairAddress, "0x456");
  });

  it("falls back to configured pairs when dynamic disabled", async () => {
    process.env.TVL_WATCHER_DYNAMIC = "0";
    const pairs = await getActivePairs();
    assert.equal(pairs, DEFAULT_PAIRS);
  });
});

