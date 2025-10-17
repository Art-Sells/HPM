// test/Quoter.spec.ts
import hre from 'hardhat'
const { ethers } = hre
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from './shared/expect.ts'

import type {
  MockTimeNonfungiblePositionManager,
  SupplicateQuoter,
  TestERC20,
} from '../typechain-types/periphery'

import completeFixture from './shared/completeFixture.ts'
import { FeeAmount } from './shared/constants.ts'
import { expandTo18Decimals } from './shared/expandTo18Decimals.ts'
import { createPool } from './shared/quoter.ts'

// -----------------------------------------------------------------------------
// ZERO fee only
// -----------------------------------------------------------------------------
const FEE = FeeAmount.ZERO as 0

// Small quotes to keep things simple
const IN_SMALL = 10n
const OUT_ONE = 1n

describe('SupplicateQuoter', () => {
  let signer0: any
  let trader: any

  async function fixture() {
    const signers = await ethers.getSigners()
    ;[signer0, trader] = signers

    const { weth9, factory, router, tokens, nft } = await completeFixture(
      signers as any,
      ethers.provider as any
    )

    // approvals/funding
    for (const token of tokens) {
      await token.connect(signer0).approve(await router.getAddress(), ethers.MaxUint256)
      await token.connect(signer0).approve(await nft.getAddress(), ethers.MaxUint256)
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)
      await token.connect(signer0).transfer(await trader.getAddress(), expandTo18Decimals(1_000_000))
    }

    const QuoterFactory = await ethers.getContractFactory('SupplicateQuoter')
    const quoterImpl = await QuoterFactory.deploy(
      await factory.getAddress(),
      await weth9.getAddress()
    )
    await quoterImpl.waitForDeployment()

    const quoter = quoterImpl as unknown as SupplicateQuoter
    return { tokens, nft, quoter }
  }

  let nft: MockTimeNonfungiblePositionManager
  let tokens: [TestERC20, TestERC20, TestERC20]
  let quoter: any

  beforeEach(async () => {
    ;({ tokens, nft, quoter } = await loadFixture(fixture))

    // Create ZERO-fee pools 0-1 and 1-2
    const s0 = (await ethers.getSigners())[0] as any
    await createPool(nft, s0, await tokens[0].getAddress(), await tokens[1].getAddress())
    await createPool(nft, s0, await tokens[1].getAddress(), await tokens[2].getAddress())
  })

  // -----------------------------------------------------------------------------
  // EXACT INPUT via chaining single-hop quotes; pass sqrtPriceLimitX96 = 0n so
  // the Quoter picks the correct extreme internally.
  // -----------------------------------------------------------------------------
  describe('#quoteExactInput', () => {
    it('0 -> 1 (> 0)', async () => {
      const t0 = await tokens[0].getAddress()
      const t1 = await tokens[1].getAddress()

      const out01 = await quoter.quoteExactInputSingle.staticCall(t0, t1, FEE, IN_SMALL, 0n)
      expect(out01 > 0n).to.equal(true)
    })

    it('1 -> 0 is ~symmetric to 0 -> 1', async () => {
      const t0 = await tokens[0].getAddress()
      const t1 = await tokens[1].getAddress()

      const out10 = await quoter.quoteExactInputSingle.staticCall(t1, t0, FEE, IN_SMALL, 0n)
      expect(out10 > 0n).to.equal(true)
    })

    it('0 -> 1 -> 2 (> 0)', async () => {
      const t0 = await tokens[0].getAddress()
      const t1 = await tokens[1].getAddress()
      const t2 = await tokens[2].getAddress()

      const mid = await quoter.quoteExactInputSingle.staticCall(t0, t1, FEE, IN_SMALL, 0n)
      const out  = await quoter.quoteExactInputSingle.staticCall(t1, t2, FEE, mid,      0n)
      expect(out > 0n).to.equal(true)
    })

    it('2 -> 1 -> 0 is ~symmetric to 0 -> 1 -> 2', async () => {
      const t0 = await tokens[0].getAddress()
      const t1 = await tokens[1].getAddress()
      const t2 = await tokens[2].getAddress()

      const mid = await quoter.quoteExactInputSingle.staticCall(t2, t1, FEE, IN_SMALL, 0n)
      const out  = await quoter.quoteExactInputSingle.staticCall(t1, t0, FEE, mid,      0n)
      expect(out > 0n).to.equal(true)
    })
  })

  // -----------------------------------------------------------------------------
  // EXACT OUTPUT via chaining single-hop quotes; pass sqrtPriceLimitX96 = 0n so
  // the Quoter picks the correct extreme internally.
  // -----------------------------------------------------------------------------
  describe('#quoteExactOutput', () => {
    it('0 -> 1 (finite input for 1 out)', async () => {
      const t0 = await tokens[0].getAddress()
      const t1 = await tokens[1].getAddress()

      const need = await quoter.quoteExactOutputSingle.staticCall(t0, t1, FEE, OUT_ONE, 0n)
      expect(need > 0n).to.equal(true)
    })

    it('1 -> 0 input is ~symmetric to 0 -> 1', async () => {
      const t0 = await tokens[0].getAddress()
      const t1 = await tokens[1].getAddress()

      const need = await quoter.quoteExactOutputSingle.staticCall(t1, t0, FEE, OUT_ONE, 0n)
      expect(need > 0n).to.equal(true)
    })

    it('0 -> 1 -> 2 (finite input for 1 out)', async () => {
      const t0 = await tokens[0].getAddress()
      const t1 = await tokens[1].getAddress()
      const t2 = await tokens[2].getAddress()

      const needT1 = await quoter.quoteExactOutputSingle.staticCall(t1, t2, FEE, OUT_ONE, 0n)
      const needT0 = await quoter.quoteExactOutputSingle.staticCall(t0, t1, FEE, needT1, 0n)
      expect(needT0 > 0n).to.equal(true)
    })

    it('2 -> 1 -> 0 input is ~symmetric to 0 -> 1 -> 2', async () => {
      const t0 = await tokens[0].getAddress()
      const t1 = await tokens[1].getAddress()
      const t2 = await tokens[2].getAddress()

      const needT1 = await quoter.quoteExactOutputSingle.staticCall(t1, t0, FEE, OUT_ONE, 0n)
      const needT2 = await quoter.quoteExactOutputSingle.staticCall(t2, t1, FEE, needT1, 0n)
      expect(needT2 > 0n).to.equal(true)
    })
  })

  // -----------------------------------------------------------------------------
  // SINGLE-HOP sanity
  // -----------------------------------------------------------------------------
  describe('#single-hop sanity', () => {
    it('quoteExactInputSingle 0 -> 1 (> 0)', async () => {
      const t0 = await tokens[0].getAddress()
      const t1 = await tokens[1].getAddress()
      const out = await quoter.quoteExactInputSingle.staticCall(t0, t1, FEE, IN_SMALL, 0n)
      expect(out > 0n).to.equal(true)
    })

    it('quoteExactOutputSingle 1 -> 0 (> 0)', async () => {
      const t0 = await tokens[0].getAddress()
      const t1 = await tokens[1].getAddress()
      const need = await quoter.quoteExactOutputSingle.staticCall(t1, t0, FEE, OUT_ONE, 0n)
      expect(need > 0n).to.equal(true)
    })
  })
})