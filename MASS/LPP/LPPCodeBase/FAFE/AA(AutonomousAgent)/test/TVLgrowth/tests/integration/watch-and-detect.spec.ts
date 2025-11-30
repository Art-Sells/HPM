import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";

import { getDefaultAdapters } from "../../src/adapters";
import { runWatcherOnce } from "../../src/watcher";
import { createExecutionStub } from "../utils/executionStub";
import { createSampleLoanQuotes } from "../utils/sampleLoans";

describe("integration: watch -> detect pipeline", () => {
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

  it("writes NDJSON logs with opportunities", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tvl-watch-"));
    const realNow = Date.now;
    const fixedNow = 1_700_000_000_000;
    // deterministic timestamps for test
    (Date as any).now = () => fixedNow;
    try {
      const result = await runWatcherOnce({
        adapters: getDefaultAdapters(),
        logDir: tmpDir,
        loanQuotes: createSampleLoanQuotes(),
        execution: createExecutionStub(),
      });
      assert.equal(result.timestamp, fixedNow);
      assert.ok(result.mispricings.length > 0, "should detect mispricings");
      assert.ok(result.loanQuotes.length > 0, "should include loan quotes");

      const files = fs.readdirSync(tmpDir);
      assert.equal(files.length, 1, "one log file written");
      const logPath = path.join(tmpDir, files[0]);
      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const payload = JSON.parse(lines[0]);
      assert.equal(payload.timestamp, fixedNow);
      assert.ok(Array.isArray(payload.mispricings));
      assert.ok(payload.mispricings.length > 0);
      assert.ok(Array.isArray(payload.loanQuotes));
      assert.ok(payload.loanQuotes.length > 0);
    } finally {
      (Date as any).now = realNow;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

