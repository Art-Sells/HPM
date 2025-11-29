# TVL Growth Test Plan

## Scope
Validate the full research loop:

1. **Quote ingestion** — adapters return normalized snapshots for every Base DEX/aggregator.
2. **Loan ingestion** — loan feeds (AAVE, etc.) provide available size + APR so we know what the AA can actually borrow.
3. **Mispricing detector** — raw snapshots produce profit-positive alerts (net USD after gas) with correct liquidity tags.
4. **Arb simulator** — replays alerts against depth curves and returns post-slippage PnL (minus loan cost).
5. **Dashboard data** — aggregates show accurate counts and percentiles.
6. **AA feedback** — generated playbook updates the AA daily runner.

## Unit Tests

| Area | Test | Notes |
| --- | --- | --- |
| adapters | `adapters/__tests__/uniswap.spec.ts` | mock RPC + REST responses, ensure normalization |
| detectors | `detectors/__tests__/thresholds.spec.ts` | feed synthetic quotes, assert profit/loss classification |
| simulator | `sim/__tests__/slippage.spec.ts` | load CSV depth curves, ensure final price matches expectation |
| persistence | `db/__tests__/writer.spec.ts` | flush NDJSON/Parquet files, verify schema |

## Integration Tests

1. `tests/integration/watch-and-detect.spec.ts`
   - spin up http mocks for each venue
   - run watcher + detector pipeline
   - assert that `logs/mispricings.ndjson` contains expected records

2. `tests/integration/simulate-and-score.spec.ts`
   - load mispricing sample
   - execute simulator
   - ensure final PnL > 0 for chosen cases or flagged as “slippage killed”

3. `tests/integration/generate-playbook.spec.ts`
   - aggregate logs
   - produce JSON playbook
   - compare snapshot to expected ranking

## Dashboard Smoke Tests

Once charts exist, capture static JSON from the data pipeline and ensure plotted metrics (edge frequency, persistence, deposit potential) match known fixtures.

## Future Work

- Replay actual Base blocks to confirm that detected edges also appear on-chain.
- Add Chaos tests: drop aggregator responses, simulate stale prices, ensure pipeline degrades gracefully.

## Execution Roadmap

| Phase | Goal | Deliverables |
| --- | --- | --- |
| P0 | Build quote/loan adapters + snapshot fixtures | `adapters/*`, `fixtures/quotes/*.json`, `fixtures/loans/*.json`, adapter unit specs |
| P1 | Wire detector + dynamic pair discovery + persistence | `watcher.ts`, `pairs.ts` discovery helpers, `detectors/mispricing.ts`, log writers |
| P2 | Arb simulator + ranking | `sim/arbitrage.ts`, slippage specs, scoring snapshots |
| P3 | Playbook + AA integration tests | `strategies/*`, `tests/integration/playbook-to-aa.spec.ts`, `DailyOperations` hook |
| P4 | Dashboard & alert smoke tests | datasource scripts, dashboard config, validation snapshots |

Each phase should land with at least one automated test plus fixture data under `fixtures/`.

