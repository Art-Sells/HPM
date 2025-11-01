yarn hardhat test test/Base64.spec.ts
yarn hardhat test test/CallbackValidation.spec.ts
yarn hardhat test test/LiquidityAmounts.spec.ts
yarn hardhat test test/Multicall.spec.ts
yarn hardhat test test/NFTDescriptor.spec.ts
- yarn hardhat run scripts/printPoolInitCodeHash.mjs
- and copy/paste code into both spec and contract after 
- re-running NFTDescriptor
yarn hardhat test test/NonfungiblePoolAddress.hash.spec.ts
yarn hardhat test test/NonfungiblePositionManager.spec.ts
yarn hardhat test test/NonFungibleTokenPositionDescriptor.spec.ts
yarn hardhat test test/OracleLibrary.spec.ts
yarn hardhat test test/PairFlash.spec.ts
yarn hardhat test test/Path.spec.ts
yarn hardhat test test/PeripheryImmutableState.spec.ts
yarn hardhat test test/PoolAddress.spec.ts
yarn hardhat test test/PoolTicksCounter.spec.ts
yarn hardhat test test/PositionValue.spec.ts
yarn hardhat test test/Quoter.spec.ts
yarn hardhat test test/QuoterV2.spec.ts
yarn hardhat test test/SelfPermit.spec.ts
yarn hardhat test test/shared/formatSqrtRatioX96.spec.ts
yarn hardhat test test/SupplicateRouter.gas.spec.ts
yarn hardhat test test/SupplicateRouter.spec.ts
yarn hardhat test test/TickLens.spec.ts