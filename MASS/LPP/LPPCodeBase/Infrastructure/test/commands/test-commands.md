yarn hardhat test test/AccessGating.Supplicate.spec.ts
yarn hardhat test test/Bootstrap.spec.ts
yarn hardhat test test/PoolMath.spec.ts
yarn hardhat test test/QuoterAccuracy.spec.ts
yarn hardhat test test/QuoterMCV.spec.ts
yarn hardhat test test/Revocation.spec.ts
yarn hardhat test test/SupplicateApproved.spec.ts
yarn hardhat test test/SwapMCV.spec.ts
-----
yarn hardhat test test/MEV/test/QuoterMCV.spec.ts
yarn hardhat test test/MEV/test/SwapMCV.spec.ts

---Test below after MEV (off-chain) tests complete
yarn hardhat test test/TreasuryWithdrawal.spec.ts

---Test below after MEV (on-chain) tests complete
yarn hardhat test test/Reentrancy.spec.ts