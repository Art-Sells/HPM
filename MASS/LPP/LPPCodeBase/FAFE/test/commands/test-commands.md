# FAFE Test Commands

npx hardhat test test/AccessGating.spec.ts
npx hardhat test test/Bootstrap.spec.ts
npx hardhat test test/PoolMath.spec.ts
npx hardhat test test/QuoterAccuracy.spec.ts
npx hardhat test test/Reentrancy.spec.ts
npx hardhat test test/Revocation.spec.ts
npx hardhat test test/SupplicateSwapApproved.spec.ts
npx hardhat test test/TreasuryWithdrawal.spec.ts -- no one other than treasuryOp should be able to withdraw or pause/unpause router... test if router is paused, supplications/swaps cannot go through. 

- Future AA / FAFE Operation Suites
- - Placeholder for upcoming AA controller specs and six-pool regression tests.

