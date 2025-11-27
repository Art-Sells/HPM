# FAFE Test Commands

npx hardhat test test/AccessGating.spec.ts
npx hardhat test test/Bootstrap.spec.ts
npx hardhat test test/PoolMath.spec.ts
npx hardhat test test/QuoterAccuracy.spec.ts
npx hardhat test test/Reentrancy.spec.ts
npx hardhat test test/Revocation.spec.ts
npx hardhat test test/SupplicateSwapApproved.spec.ts -- lets add (if they don't already exist) tests to test before and after of treasury and pools after AA FAFE operation swaps/deposits (also inside the smart contracts in deposit (that deposits profits into the pools) that part of the deposits lets say 10% goes into the treasury, we might have to add this first) and test
npx hardhat test test/TreasuryWithdrawal.spec.ts -- no one other than treasuryOp should be able to withdraw 

- Future AA / FAFE Operation Suites
- - Placeholder for upcoming AA controller specs and six-pool regression tests.

