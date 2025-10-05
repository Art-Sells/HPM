// test/shared/completeFixture.ts
import hre from 'hardhat';
const { ethers } = hre;

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { MaxUint256 } from 'ethers';

import { v3RouterFixture } from './externalFixtures.ts';

import type {
  IWETH9,
  MockTimeSupplicateRouter,
  TestERC20,
} from '../../typechain-types/periphery';
import type { ILPPFactory } from '../../typechain-types/protocol';

type CompleteFixture = {
  weth9: IWETH9;
  factory: ILPPFactory;
  router: MockTimeSupplicateRouter;
  tokens: [TestERC20, TestERC20, TestERC20];
};

export default async function completeFixture(
  [wallet]: SignerWithAddress[],
  provider: any
): Promise<CompleteFixture> {
  // v3RouterFixture must also accept SignerWithAddress[] (see note below)
  const { weth9, factory, router } = await v3RouterFixture([wallet], provider);

  const tokenFactory = await ethers.getContractFactory('TestERC20');
  const half = MaxUint256 / 2n; // ethers v6 constants are bigint

  const t0 = (await tokenFactory.deploy(half)) as unknown as TestERC20;
  const t1 = (await tokenFactory.deploy(half)) as unknown as TestERC20;
  const t2 = (await tokenFactory.deploy(half)) as unknown as TestERC20;

  const tokens = [t0, t1, t2] as [TestERC20, TestERC20, TestERC20];

  await Promise.all(tokens.map(t => t.waitForDeployment()));
  tokens.sort((a, b) => ((a.target as string).toLowerCase() < (b.target as string).toLowerCase() ? -1 : 1));
  return { weth9, factory, router, tokens };
}