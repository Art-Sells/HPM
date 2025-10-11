// test/shared/completeFixture.ts
import hre from 'hardhat'
const { ethers } = hre

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { MaxUint256 } from 'ethers'

import { lppRouterFixture } from './externalFixtures.ts'

import type {
  IWETH9,

  MockTimeSupplicateRouter,

  MockTimeNonfungiblePositionManager,
  NonfungibleTokenPositionDescriptor,
  TestERC20,
} from '../../typechain-types/periphery'

import type { ILPPFactory } from '../../typechain-types/protocol'

type CompleteFixture = {
  weth9: IWETH9
  factory: ILPPFactory
  router: MockTimeSupplicateRouter
  tokens: [TestERC20, TestERC20, TestERC20]
  nftDescriptor: NonfungibleTokenPositionDescriptor
  nft: MockTimeNonfungiblePositionManager
}

export default async function completeFixture(
  [wallet]: SignerWithAddress[],
  provider: any
): Promise<CompleteFixture> {

  const { weth9, factory, router } = await lppRouterFixture([wallet], provider)

  // ---- test tokens (use half of MaxUint256 to avoid overflow during transfers in some tests)
  const tokenFactory = await ethers.getContractFactory('TestERC20')
  const half = MaxUint256 / 2n

  const t0 = (await tokenFactory.deploy(half)) as unknown as TestERC20
  const t1 = (await tokenFactory.deploy(half)) as unknown as TestERC20
  const t2 = (await tokenFactory.deploy(half)) as unknown as TestERC20
  const tokens = [t0, t1, t2] as [TestERC20, TestERC20, TestERC20]

  await Promise.all(tokens.map(t => t.waitForDeployment()))
  tokens.sort((a, b) => ((a.target as string).toLowerCase() < (b.target as string).toLowerCase() ? -1 : 1))

  // ---- link & deploy the on-chain NFT metadata/descriptor pieces
  // 1) Library: NFTDescriptor
  const nftDescLibFactory = await ethers.getContractFactory('NFTDescriptor')
  const nftDescLib = await nftDescLibFactory.deploy()
  await nftDescLib.waitForDeployment()

  // 2) NonfungibleTokenPositionDescriptor (linked to NFTDescriptor)
  //    Constructor usually takes WETH9 address and a bytes32 native label (e.g. "ETH")
  const positionDescriptorFactory = await ethers.getContractFactory('NonfungibleTokenPositionDescriptor', {
    libraries: { NFTDescriptor: nftDescLib.target as string },
  })
  const nftDescriptor = (await positionDescriptorFactory.deploy(
    weth9.target as string,
    ethers.encodeBytes32String('ETH')
  )) as unknown as NonfungibleTokenPositionDescriptor
  await nftDescriptor.waitForDeployment()

  // 3) MockTimeNonfungiblePositionManager (factory, WETH9, descriptor)
  const positionManagerFactory = await ethers.getContractFactory('MockTimeNonfungiblePositionManager')
  const nft = (await positionManagerFactory.deploy(
    factory.target as string,
    weth9.target as string,
    nftDescriptor.target as string
  )) as unknown as MockTimeNonfungiblePositionManager
  await nft.waitForDeployment()

  return {
    weth9,
    factory,
    router,
    tokens,
    nftDescriptor,
    nft,
  }
}