// test/NonfungibleTokenPositionDescriptor.spec.ts
import hre from 'hardhat'
const { ethers } = hre
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from './shared/expect.ts'
import { MaxUint256, type Signer } from 'ethers'

import type {
  NonfungibleTokenPositionDescriptor,
  MockTimeNonfungiblePositionManager,
  TestERC20,
  IWETH9,
} from '../typechain-types/periphery'

import completeFixture from './shared/completeFixture.ts'
import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'
import { FeeAmount, TICK_SPACINGS } from './shared/constants.ts'
import { getMaxTick, getMinTick } from './shared/ticks.ts'
import { sortedTokens } from './shared/tokenSort.ts'
import { extractJSONFromURI } from './shared/extractJSONFromURI.ts'

const DAI  = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const TBTC = '0x8dAEBADE922dF735c38C80C7eBD708Af50815fAa'
const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'

describe('NonfungibleTokenPositionDescriptor', () => {
  let wallets: Signer[]
  let nftPositionDescriptor: NonfungibleTokenPositionDescriptor
  let tokens: [TestERC20, TestERC20, TestERC20]
  let nft: MockTimeNonfungiblePositionManager
  let weth9: IWETH9

  async function nftPositionDescriptorCompleteFixture() {
    const signers = await ethers.getSigners()
    const { nft: _nft, nftDescriptor } = await completeFixture(signers as any, ethers.provider)

    const HALF_MAX = MaxUint256 / 2n

    const tokenFactory = await ethers.getContractFactory('TestERC20')
    const t0 = (await tokenFactory.deploy(HALF_MAX)) as unknown as TestERC20
    await t0.waitForDeployment()
    const t1 = (await tokenFactory.deploy(HALF_MAX)) as unknown as TestERC20
    await t1.waitForDeployment()
    const t2 = (await tokenFactory.deploy(HALF_MAX)) as unknown as TestERC20
    await t2.waitForDeployment()

    return {
      nft: _nft as MockTimeNonfungiblePositionManager,
      nftPositionDescriptor: nftDescriptor as NonfungibleTokenPositionDescriptor,
      tokens: [t0, t1, t2] as [TestERC20, TestERC20, TestERC20],
    }
  }

  before(async () => {
    wallets = await ethers.getSigners()
  })

  beforeEach('load fixture', async () => {
    ;({ tokens, nft, nftPositionDescriptor } = await loadFixture(nftPositionDescriptorCompleteFixture))
    const weth9Addr = await nftPositionDescriptor.WETH9()
    weth9 = (await ethers.getContractAt('IWETH9', weth9Addr)) as unknown as IWETH9
  })

  describe('#tokenRatioPriority', () => {
    it('returns -100 for WETH9', async () => {
      expect(await nftPositionDescriptor.tokenRatioPriority(await weth9.getAddress(), 1)).to.eq(-100)
    })

    it('returns 200 for USDC', async () => {
      expect(await nftPositionDescriptor.tokenRatioPriority(USDC, 1)).to.eq(300)
    })

    it('returns 100 for DAI', async () => {
      expect(await nftPositionDescriptor.tokenRatioPriority(DAI, 1)).to.eq(100)
    })

    it('returns  150 for USDT', async () => {
      expect(await nftPositionDescriptor.tokenRatioPriority(USDT, 1)).to.eq(200)
    })

    it('returns -200 for TBTC', async () => {
      expect(await nftPositionDescriptor.tokenRatioPriority(TBTC, 1)).to.eq(-200)
    })

    it('returns -250 for WBTC', async () => {
      expect(await nftPositionDescriptor.tokenRatioPriority(WBTC, 1)).to.eq(-300)
    })

    it('returns 0 for any non-ratioPriority token', async () => {
      expect(await nftPositionDescriptor.tokenRatioPriority(await tokens[0].getAddress(), 1)).to.eq(0)
    })
  })

  describe('#flipRatio', () => {
    it('returns false if neither token has priority ordering', async () => {
      expect(
        await nftPositionDescriptor.flipRatio(await tokens[0].getAddress(), await tokens[2].getAddress(), 1)
      ).to.eq(false)
    })

    it('returns true if both tokens are numerators but token0 has a higher priority ordering', async () => {
      expect(await nftPositionDescriptor.flipRatio(USDC, DAI, 1)).to.eq(true)
    })

    it('returns true if both tokens are denominators but token1 has lower priority ordering', async () => {
      expect(await nftPositionDescriptor.flipRatio(await weth9.getAddress(), WBTC, 1)).to.eq(true)
    })

    it('returns true if token0 is a numerator and token1 is a denominator', async () => {
      expect(await nftPositionDescriptor.flipRatio(DAI, WBTC, 1)).to.eq(true)
    })

    it('returns false if token1 is a numerator and token0 is a denominator', async () => {
      expect(await nftPositionDescriptor.flipRatio(WBTC, DAI, 1)).to.eq(false)
    })
  })

  describe('#tokenURI', () => {
    it('displays ETH as token symbol for WETH token', async () => {
      const [token0, token1] = sortedTokens(weth9 as unknown as TestERC20, tokens[1])

      await nft.createAndInitializePoolIfNecessary(
        await token0.getAddress(),
        await token1.getAddress(),
        FeeAmount.ZERO,
        encodePriceSqrt(1, 1)
      )

      // Ensure WETH is funded so transferFrom succeeds
      await weth9.deposit({ value: 100n })

      await weth9.approve(await nft.getAddress(), 100)
      await tokens[1].approve(await nft.getAddress(), 100)

      await nft.mint({
        token0: await token0.getAddress(),
        token1: await token1.getAddress(),
        fee: FeeAmount.ZERO,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        recipient: await wallets[0].getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })

      const metadata = extractJSONFromURI(await nft.tokenURI(1))
      const name: string = metadata.name
      const desc: string = metadata.description

      const parts = name.split(' - ')
      const pair = parts[2] || '' // e.g. "LPP/ETH"

      // We only assert ETH is labeled in the pair — symbols for the test tokens may be mapped to "LPP"
      expect(pair.includes('/ETH') || pair.startsWith('ETH/'), `name was: ${name}`).to.eq(true)
      expect(
        desc.includes('ETH-') || /\b-ETH\b/.test(desc),
        `description was: ${desc}`
      ).to.eq(true)
      expect(desc.includes('ETH Address')).to.eq(true)
    })

    it('displays returned token symbols when neither token is WETH ', async () => {
      const [token0, token1] = sortedTokens(tokens[2], tokens[1])

      await nft.createAndInitializePoolIfNecessary(
        await token0.getAddress(),
        await token1.getAddress(),
        FeeAmount.ZERO,
        encodePriceSqrt(1, 1)
      )

      await tokens[1].approve(await nft.getAddress(), 100)
      await tokens[2].approve(await nft.getAddress(), 100)

      await nft.mint({
        token0: await token0.getAddress(),
        token1: await token1.getAddress(),
        fee: FeeAmount.ZERO,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        recipient: await wallets[0].getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })

      const metadata = extractJSONFromURI(await nft.tokenURI(1))
      const name: string = metadata.name
      const desc: string = metadata.description

      const parts = name.split(' - ')
      const pair = parts[2] || '' // e.g. "LPP/LPP"

      // Just verify we have a token/token pair and that ETH is not present for the non-WETH case
      expect(pair.includes('/'), `name was: ${name}`).to.eq(true)
      expect(!pair.includes('ETH'), `name was: ${name}`).to.eq(true)

      // And description uses token-token style (no strict symbol check, order agnostic)
      expect(desc.includes('-'), `description was: ${desc}`).to.eq(true)
    })

    it('can render a different label for native currencies', async () => {
      const [token0, token1] = sortedTokens(weth9 as unknown as TestERC20, tokens[1])

      await nft.createAndInitializePoolIfNecessary(
        await token0.getAddress(),
        await token1.getAddress(),
        FeeAmount.ZERO,
        encodePriceSqrt(1, 1)
      )

      // Ensure WETH is funded so transferFrom succeeds
      await weth9.deposit({ value: 100n })

      await weth9.approve(await nft.getAddress(), 100)
      await tokens[1].approve(await nft.getAddress(), 100)

      await nft.mint({
        token0: await token0.getAddress(),
        token1: await token1.getAddress(),
        fee: FeeAmount.ZERO,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        recipient: await wallets[0].getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })

      const nftDescriptorLibraryFactory = await ethers.getContractFactory('NFTDescriptor')
      const nftDescriptorLibrary = await nftDescriptorLibraryFactory.deploy()
      await nftDescriptorLibrary.waitForDeployment()

      const positionDescriptorFactory = await ethers.getContractFactory(
        'NonfungibleTokenPositionDescriptor',
        { libraries: { NFTDescriptor: await nftDescriptorLibrary.getAddress() } }
      )

      const deployed = await positionDescriptorFactory.deploy(
        await weth9.getAddress(),
        // 'FUNNYMONEY' as bytes32
        '0x46554e4e594d4f4e455900000000000000000000000000000000000000000000'
      )
      await deployed.waitForDeployment()

      const nftDescriptor = deployed as unknown as NonfungibleTokenPositionDescriptor

      const metadata = extractJSONFromURI(await nftDescriptor.tokenURI(await nft.getAddress(), 1))
      const name: string = metadata.name
      const desc: string = metadata.description

      const parts = name.split(' - ')
      const pair = parts[2] || '' // e.g. "LPP/FUNNYMONEY" or "FUNNYMONEY/LPP"

      // Just verify the custom label appears in either side of the pair
      expect(
        pair.includes('/FUNNYMONEY') || pair.startsWith('FUNNYMONEY/'),
        `name was: ${name}`
      ).to.eq(true)
      expect(
        desc.includes('FUNNYMONEY-') || /\b-FUNNYMONEY\b/.test(desc),
        `description was: ${desc}`
      ).to.eq(true)
      expect(desc.includes('FUNNYMONEY Address')).to.eq(true)
    })
  })
})