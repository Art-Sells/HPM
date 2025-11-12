# LPP Security Hardening & Test Plan

This document enumerates **all guards to add** and **all tests to implement** based solely on the current Solidity you shared. It’s structured as a checklist you can execute incrementally.

---

## Contents
- [Scope](#scope)
- [Contracts](#contracts)
- [Guards To Add (Code Changes)](#guards-to-add-code-changes)
- [Test Matrix (What We Will Test)](#test-matrix-what-we-will-test)
- [Attack Simulations & Adversarial Fixtures](#attack-simulations--adversarial-fixtures)
- [Fuzzing & Property Tests](#fuzzing--property-tests)
- [Governance & Operations Safety](#governance--operations-safety)
- [Snapshots & Human-Readable Outputs](#snapshots--human-readable-outputs)
- [How To Run](#how-to-run)
- [Future Work](#future-work)

---

## Scope

We harden:
- Vesting payouts & schedules
- Pool swaps/mints/burns
- Rebate vault & treasury drains
- Router permissions
- ERC20 quirks (fee-on-transfer, non-standard returns, ERC777 hooks)
- Donation/sync mismatches
- Governance griefing
- DoS vectors and gas bombs

---

## Contracts

- **LPPVesting.sol**
- **LPPPool.sol**
- **LPPMintHook.sol**
- **LPPRebateVault.sol**
- **LPPTreasury.sol**
- **LPPRouter.sol**
- **LPPFactory.sol**
- **Access / Interfaces / SafeERC20**

---

## Guards To Add (Code Changes)

### Global
- [ ] **ReentrancyGuard** in: `LPPPool`, `LPPMintHook`, `LPPVesting`, `LPPTreasury`, `LPPRebateVault` (withdraw), and any future callback surfaces.
- [ ] **SafeERC20 (OZ-style)**: replace custom wrapper with low-level call that tolerates no-return tokens; or strictly **allow-list** ERC20s (reject non-standard).
- [ ] **Fee-aware accounting**: always compute received amounts via **balance deltas** before/after `transferFrom`.

### LPPVesting
- [ ] Gate `grant()` with `onlyTreasury` (or allow-list issuers).
- [ ] In `_claim`, **snapshot token list to memory** (prevent mid-loop growth visibility).
- [ ] Optional: **pagination** `claimRange(beneficiary, start, end)` and/or `claim(token)` to prevent claim DoS via many tokens.
- [ ] Governance constraints (see Governance section): only-future `startTime`, non-decreasing `epochSeconds`, schedule “monotone dominance” (no front-load).

### LPPPool
- [ ] Add `sync()` to reconcile reserves to actual balances; call or validate deltas in `supplicate`/`mintFromHook`.
- [ ] Make `burn` actually **transfer proportional tokens** to `to` and update reserves via **balance deltas**. Add min-liquidity checks.
- [ ] Reentrancy guard wrap `supplicate`, `mintFromHook`, `bootstrapInitialize`.
- [ ] Slippage: ensure swap & mint have **user-provided minimums** (mint via Hook param `minLiquidityOut`).

### LPPMintHook
- [ ] All split calculations (mint/rebate/retention) performed on **received** amounts (post-fee).
- [ ] Add `minLiquidityOut` / `minNetToPool` parameters to guard value.
- [ ] Tier hysteresis (require sticking in tier N for T seconds/blocks) to reduce boundary gaming.

### LPPTreasury
- [ ] `withdrawERC20` marked **nonReentrant**; update internal accounting (if any) **before** external calls.
- [ ] Consider **pull pattern** (queued withdrawals) for high-assurance flows.

### LPPRebateVault
- [ ] Add **withdrawERC20** (treasury/owner-authorized) with **nonReentrant**.
- [ ] Optionally convert to accounting-only vault and **pay rebates directly** to LP-MCV.

### LPPRouter
- [ ] LP-MCV permission requires **min LP balance** (not 1 wei).
- [ ] Add **revocation**/blacklist in `AccessManager`.
- [ ] Optional: time-decayed permission or per-pool epoch freshness.

### LPPFactory
- [ ] No change required beyond event/audit trails; ensure hook can only be set once (already enforced), emit strong events.

---

## Test Matrix (What We Will Test)

> Each item corresponds to at least one dedicated `describe(...)` block and snapshot.

### 1) Vesting – Epochs & Schedules (Human Readable)
- [ ] Epoch increment around boundary (−1s, +0s, +1s); snapshots show **seconds + human** (days/hours/mins).
- [ ] Schedule sums ≤10_000 bps; snapshots display **bps & %** and **expanded schedule** with per-epoch durations.
- [ ] Treasury-only mutations: `setEpochSeconds`, `setStartTime`, `setSchedule`, `setScheduleAt`, `addScheduleTail`, `clearSchedule`.
- [ ] Non-Treasury attempts revert (accept **custom errors** or revert strings).
- [ ] **Old vs New** schedule/epoch snapshots in human units (e.g., `2,000,000s ≈ 23d 3h 33m`).

### 2) Vesting – Payouts & Reentrancy
- [ ] **Early claim reverts** before epoch 0 completes.
- [ ] **Full payout after final epoch** to LP-MCV when vault approved (approve in test).
- [ ] Reentrancy via **malicious token** during `transferFrom` (ERC777-like): claimed updated **before** external call prevents double-pay; assert no overpayment.
- [ ] **Mid-loop token-list growth**: reenter to `grant()` → new token **not processed** in same claim (memory-snapshotted iteration).
- [ ] **DoS/Gas bomb**: many dust grants; `claim()` heavy → `claimRange` succeeds.

### 3) Pool – Swaps (`supplicate`) & Reentrancy
- [ ] Reentrancy attacker tries to reenter during outbound `transfer` → guard blocks second entry; reserves consistent.
- [ ] Donation mismatch: direct token donation to pool → `supplicate` **reverts** or `sync()` reconciles → quotes/amountOut correct.
- [ ] Fee-on-transfer token as input: reserves and amountOut computed from **received**; invariant respected.
- [ ] Micro-swap alternating sequences: ensure **no value bleed** (rounding favors pool).

### 4) Pool – Mint & Burn
- [ ] `mintFromHook` uses **net received** amounts; split math honors rounding; **minLiquidityOut** enforced.
- [ ] Tier boundary tests (shareBps near thresholds): 499/500/999/1000/1999/2000/3499/3500/4999/5000 → correct tier; with hysteresis on, boundary flapping prevented.
- [ ] `burn` returns proportional tokens, actually **transfers** to `to`, reserves updated via **deltas**; fuzz amounts for rounding.
- [ ] Attempt burns w/out liquidity → revert.

### 5) Hook – Rebate/Retention
- [ ] Reentrancy during multi-`safeTransferFrom` pulls (rebate/retention/pool) blocked by guard; end state consistent.
- [ ] Fee-on-transfer flows through entire split correctly (net basis).
- [ ] Tiny-deposit rounding: ensure mint leg and skim legs obey minimums; no accidental 100% skim.

### 6) Treasury & RebateVault – Withdrawals
- [ ] Malicious token `transfer()` that reenters `withdrawERC20`: with guard, only one transfer succeeds; balances correct.
- [ ] RebateVault withdrawal works, reentrancy-guarded.
- [ ] Optional pull pattern (if implemented): queued then pulled by receiver.

### 7) Router – Permissions
- [ ] LP with **< min LP** cannot call `supplicate`.
- [ ] LP with ≥ min LP allowed; after **revocation**, reverts.
- [ ] Verify `AccessManager` integration paths.

### 8) ERC20 Quirks
- [ ] Non-standard token **without bool return**: with OZ-safe wrapper → success; with policy mode → revert with clear reason.
- [ ] ERC777-like hooked token exercising reentrancy attempts across Vesting/Pool/Hook.

### 9) Governance Constraints
- [ ] `setStartTime` **in the past** → revert.
- [ ] `setEpochSeconds` **decrease** → revert (non-decreasing).
- [ ] **Monotone dominance** schedule rule: new cumulative cannot exceed old at any epoch index; violating schedules revert.

---

## Attack Simulations & Adversarial Fixtures

Create these test doubles in `test/shared/mocks`:

- [ ] **MaliciousERC20_ReenterOnTransfer**: on `transfer`/`transferFrom` invoke callback back into target function.
- [ ] **FeeOnTransferERC20(percent)**: skims N% on inbound transfers.
- [ ] **NoReturnERC20**: ERC20 methods succeed but **no return data**.
- [ ] **ERC777Like**: simulate hooks on send/receive (best-effort).
- [ ] **MaliciousReceiver**: a contract used as `vault`/`treasury` receiver that reenters callers.
- [ ] **DonationHelper**: helper to “force donate” tokens to pool to test `sync()`/mismatch.

Each mock includes knobs to toggle behavior at runtime.

---

## Fuzzing & Property Tests

- [ ] **Swap invariants**: For randomized sequences of swaps, pool’s total value (asset+usdc under implied price) never decreases beyond a bounded rounding tolerance.
- [ ] **Burn conservation**: Sum of reserves + user balances conserved within 1 wei bounds across mint-burn roundtrips.
- [ ] **Tier boundary fuzz**: random deposits around boundaries; assert tier stability with hysteresis.
- [ ] **Schedule fuzz**: randomly generated schedules (sum ≤ 10_000) + random epochSeconds; ensure claim monotonicity (claimed never decreases; never exceeds grants).

---

## Governance & Operations Safety

- [ ] **Timelock / Multi-sig** (out of scope for Solidity here, but document): critical funcs routed through delayed governance.
- [ ] **Event coverage**: assert events for epochs/schedules/withdrawals/hooks/tiers.
- [ ] **Pausing/kill-switch (optional)**: if introduced, tests for pause gating.

---

## Snapshots & Human-Readable Outputs

- [ ] All epoch-related snapshots show: `NN seconds (D days H hours M mins)`.
- [ ] Schedules snapshot as arrays of `{ bps, percent }` and **expanded** as `{ epoch, durationSeconds, durationHuman, percent }`.
- [ ] Treasury/Router permission changes snapshot addresses and flags.
- [ ] Final payout tests show total seconds, human duration, and amounts in **formatted units**.

---

## How To Run

```bash
# install
yarn

# compile
yarn hardhat compile

# run the full suite (unit + security)
yarn hardhat test

# optional: run only security tests
yarn hardhat test test/security/**/*.spec.ts