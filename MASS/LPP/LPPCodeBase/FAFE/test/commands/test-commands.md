# FAFE Test Commands

## 1. Core Access & Pool Specs
```
npx hardhat test test/AccessGating.Supplicate.spec.ts
npx hardhat test test/SupplicateApproved.spec.ts
npx hardhat test test/Bootstrap.spec.ts
```

## 2. Pricing & Math Suites
```
npx hardhat test test/PoolMath.spec.ts
npx hardhat test test/QuoterAccuracy.spec.ts
```

## 3. Deployment & Integration Snapshots
```
npx hardhat run scripts/run-fafe-flow.ts --network base
cat test/Deployment/__snapshots__/pre-supplicate.snap.json
cat test/Deployment/__snapshots__/post-supplicate.snap.json
```

## 4. Security & Governance
```
npx hardhat test test/Revocation.spec.ts
npx hardhat test test/TreasuryWithdrawal.spec.ts
npx hardhat test test/Reentrancy.spec.ts
```

## 6. Future AI / Orbit Suites
- Placeholder for upcoming AI controller specs and six-pool regression tests.

## 7. Monitoring & Tooling
```
npx hardhat run scripts/read-onchain-prices.ts --network base
npx hardhat run scripts/deploy.ts --network base
```
