## TVL Growth Research Harness

This directory hosts simulation + monitoring scaffolding for measuring how often Base mainnet DEX venues present profitable spreads that the AA can recycle into FAFE pool TVLs.  The workflow mirrors the request:

### 1. Base Token Pool Watcher + Aggregator Scanner
- `watcher.ts` (TBD) will hydrate feeds from every major router/API (Uniswap v3, Aerodrome, BaseSwap, Maverick, 1inch, 0x, Firebird, OpenOcean, Odos).
- Each venue adapter normalizes quotes into a standard payload: `{pair, venue, reserveSnapshot, midPrice, depth, gasEstimate}`.
- The watcher runs on cron (e.g., every 5s) and streams into `./logs/quotes-<timestamp>.ndjson`.
- Fixture data for local runs lives in `fixtures/quotes/*.json` so tests never hit live RPCs.
- Loan availability/APR snapshots (e.g., from AAVE) are read from `fixtures/loans/*.json`. Drop your real JSON export there to “read the quotes from the loans” without modifying code.

### 2. Mispricing Logger
- `detectors/mispricing.ts` now focuses purely on **dollar profit after gas**, not basis points. Any venue combination that yields `netProfitUsd > 0` is surfaced so the AA can borrow whichever token unlocks immediate profit (no need to compare against FAFE’s offsets).
- **Liquidity-aware sizing:** trade inputs are capped by `liquidityFraction × liquidityUsd`, so thin pools can’t fabricate huge spreads.
- **Loan matching:** an alert is emitted only if the borrow token exists in the loan feed, `available ≥ borrowSize`, **and** the quote’s `maxDurationHours` clears the configured minimum (default 0.1h). APR + that minimum duration are charged against the spread before we call it profitable.
- **Execution-grade sizing:** every candidate is repriced via live router quotes (0x Base) for both hops, and the returned gas estimate is charged against the spread. Trade size is capped by Uniswap v3 depth (via QuoterV2) or Aerodrome `getReserves()` walks rather than heuristic liquidity; heuristics only apply if `TVL_WATCHER_DEPTH_MODE=mock`.
- **No fixtures/fallbacks:** loan data is always fetched from Aave’s Base reserves; disabling the fetch simply yields an empty loan set instead of loading JSON fixtures.
- **Slippage sim:** each candidate runs through `sim/arbitrage.ts` (configurable `slippageBps`) which applies price-impact + loan-fee haircuts before it’s considered profitable.
- **Junk filtering:** venues that fail basic sanity checks (e.g., liquidity below `minLiquidityUsd`, absurd price ratios with no depth) are skipped.
- Persist every alert even when size is tiny; fields: `{pair, venueA, venueB, borrowToken, netProfitUsd, liquidityClass, timestamp}` alongside legacy edge data for reference.
- Tag liquidity bins (deep, mid, shallow) using live depth so we can later correlate success rates.

### 3. Arbitrage Simulator / Executor
- `sim/arbitrage.ts` replays logged edges against order book depth to estimate slippage and gas.
- When running on Base Sepolia, we can wire small “post-only” transactions to verify settlement assumptions without risking treasury.
- Simulation metadata (slippage, effective premium, revert reason) feeds back into the mispricing log so poor venues get down-weighted.

### 4. Dashboard
- Use a lightweight Next.js or Grafana datasource (CSV/Parquet acceptable for now) to visualize:
  - Edge frequency by token class (stable, meme, new listing, bridge asset).
  - Persistence (median lifetime of a mispricing).
  - Realized vs theoretical profit after gas.
  - Daily deposit potential into each FAFE pool (split by ASSET/USDC).
- Store dashboard config under `dashboard/` once we settle on tooling.

### 5. Feedback Into AA Loop
- Export a JSON “playbook” (e.g., `strategies/daily-playbook.json`) that ranks pools + routes by historical efficiency.
- `playbook/publisher.ts` can be run via `TS_NODE_PROJECT=... npx ts-node AA(AutonomousAgent)/test/TVLgrowth/src/playbook/publisher.ts` to emit/update the feed (loan terms are embedded in the output).
- AA daily ops can then:
  1. Query the watcher API for the best current spread (market + loan quotes) that matches desired token direction.
  2. Borrow 1% of the relevant reserve.
  3. Execute only if projected profit ≥ configured threshold (e.g., 50% premium minus fees).
  4. Deposit realized profit back via `FAFERouter.deposit`.

### Immediate TODOs
1. Define venue adapter interfaces (`src/adapters/*.ts`).
2. Build quote normalization + persistence helpers.
3. Instrument detectors + simulator to write snapshot fixtures so we can unit test them offline.
4. Hook everything into DailyOperations once confidence is high.

> **Note:** No on-chain writes happen from this folder yet; it is a research harness.  Keep credentials and API keys out of the repo and load them via `.env.local` when the watcher is implemented.

## Running Local Checks

Execute the deterministic detector test via:

```bash
TS_NODE_PROJECT=AA(AutonomousAgent)/test/TVLgrowth/tsconfig.json \
  npx mocha -r ts-node/register "AA(AutonomousAgent)/test/TVLgrowth/tests/**/*.spec.ts"
```

## Live Data Mode

- Set `TVL_WATCHER_MODE=live` to swap the mock adapters for the Dexscreener-backed adapter under `src/adapters/live/dexscreener.ts`.
- Optional: set `TVL_WATCHER_ALLOW_INSECURE=1` when running inside sandboxes that lack a CA bundle (the adapter will use an Undici agent with `rejectUnauthorized: false`).
- By default the watcher **auto-discovers the top 10 Base pools ranked by USD liquidity** before each run via Dexscreener, so you don't need to hand-maintain a pair list. Set `TVL_WATCHER_DYNAMIC=0` to force the static fallback list.
- Router execution always hits the 0x Base API (`ZERO_EX_BASE_URL` / `ZERO_EX_API_KEY`). There is no runtime “mock” execution mode; tests inject their own stubs directly.
- Optional: point `TVL_WATCHER_PAIRS=/absolute/path/to/pairs.json` at a JSON array like:

```json
[
  { "base": "ASSET", "quote": "USDC", "query": "cbETH USDC" },
  { "base": "PEPE", "quote": "cbETH", "pairAddress": "0x..." }
]
```

Fields:
- `query` – override search string when multiple tokens share the same ticker.
- `baseAddress` / `quoteAddress` – ERC20 addresses to force exact matches.
- `pairAddress` – direct DEX LP address; we’ll hit Dexscreener’s `pairs/{chain}/{pair}` endpoint and skip searching entirely.
- `chainId` – defaults to `base`, but can be set to any Dexscreener-supported chain.

See `config/pairs.sample.json` for a template. If only symbols are provided, the watcher auto-discovers the best-matching Base pools via Dexscreener and caches their addresses.
- Use `src/watcherRunner.ts` to schedule continuous captures for at least one minute and auto-publish a dashboard snapshot:

```bash
TVL_WATCHER_MODE=live \
TS_NODE_PROJECT=AA(AutonomousAgent)/test/TVLgrowth/tsconfig.json \
npx ts-node AA(AutonomousAgent)/test/TVLgrowth/src/watcherRunner.ts 60000 10000
```

Arguments: `<durationMs?> <intervalMs?> <logDir?> <outputDir?>`. Logs land in `logs/tvl-growth/*.ndjson` and the dashboard summary goes to `logs/dashboard/summary.json`.

