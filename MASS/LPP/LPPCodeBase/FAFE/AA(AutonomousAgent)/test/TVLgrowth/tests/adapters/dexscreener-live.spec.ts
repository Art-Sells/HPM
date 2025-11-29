import fs from "node:fs";
import path from "node:path";
import { strict as assert } from "node:assert";

import {
  buildQuoteFromPair,
  pickPair,
} from "../../src/adapters/live/dexscreener";
import { PairRequest } from "../../src/types";

const fixturePath = path.join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "dexscreener",
  "cbeth-usdc.json"
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

describe("dexscreener live adapter helpers", () => {
  const req: PairRequest = { base: "ASSET", quote: "USDC" };

  it("selects the deepest Base pair and builds quotes (base -> quote)", () => {
    const { pair, orientation } = pickPair(fixture.pairs, req);
    assert.ok(pair, "expected matching pair");
    assert.equal(orientation, 1);
    const quote = buildQuoteFromPair(req, pair!, orientation);
    assert.ok(quote);
    assert.equal(quote?.tokenIn, "ASSET");
    assert.ok(quote!.amountOut > 3000);
    assert.ok(quote!.liquidityUsd > 0);
  });

  it("supports reverse orientation (quote -> base)", () => {
    const reverseReq: PairRequest = { base: "USDC", quote: "ASSET" };
    const { pair, orientation } = pickPair(fixture.pairs, reverseReq);
    assert.ok(pair, "reverse pair should still match");
    assert.equal(orientation, -1);
    const quote = buildQuoteFromPair(reverseReq, pair!, orientation);
    assert.ok(quote);
    assert.ok(quote!.amountOut < 1); // 1 USDC should buy < 1 cbETH
  });
});

