// test/shared/completeFixture.ts
import hre from 'hardhat';
const { ethers } = hre;

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { MaxUint256 } from 'ethers';

import { v3RouterFixture } from './externalFixtures.ts';

import type {
  IWETH9,
  MockTimeNonfungiblePositionManager,
  MockTimeSupplicateRouter,
  NonfungibleTokenPositionDescriptor,
  TestERC20,
  ILPPFactory,
} from '../../typechain-types';

type CompleteFixture = {
  weth9: IWETH9;
  factory: ILPPFactory;
  router: MockTimeSupplicateRouter;
  nft: MockTimeNonfungiblePositionManager;
  nftDescriptor: NonfungibleTokenPositionDescriptor;
  tokens: [TestERC20, TestERC20, TestERC20];
};

export default async function completeFixture(
  [wallet]: SignerWithAddress[],
  provider: any
): Promise<CompleteFixture> {
  const { weth9, factory, router } = await v3RouterFixture([wallet], provider);

  const tokenFactory = await ethers.getContractFactory('TestERC20');
  const half = MaxUint256 / 2n; // bigint in v6

  const tokens: [TestERC20, TestERC20, TestERC20] = [
    (await tokenFactory.deploy(half)) as unknown as TestERC20, // avoid overflow vs MaxUint256
    (await tokenFactory.deploy(half)) as unknown as TestERC20,
    (await tokenFactory.deploy(half)) as unknown as TestERC20,
  ];

  const nftDescriptorLibraryFactory = await ethers.getContractFactory('NFTDescriptor');
  const nftDescriptorLibrary = await nftDescriptorLibraryFactory.deploy();

  const positionDescriptorFactory = await ethers.getContractFactory('NonfungibleTokenPositionDescriptor', {
    libraries: { NFTDescriptor: await nftDescriptorLibrary.getAddress() },
  });

  const nftDescriptor = (await positionDescriptorFactory.deploy(
    tokens[0].address,
    // 'ETH' as bytes32
    '0x4554480000000000000000000000000000000000000000000000000000000000'
  )) as unknown as NonfungibleTokenPositionDescriptor;

  const positionManagerFactory = await ethers.getContractFactory('MockTimeNonfungiblePositionManager');
  const nft = (await positionManagerFactory.deploy(
    factory.address,
    weth9.address,
    await nftDescriptor.getAddress()
  )) as unknown as MockTimeNonfungiblePositionManager;

  // Sort deterministically
  tokens.sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));

  return { weth9, factory, router, tokens, nft, nftDescriptor };
}