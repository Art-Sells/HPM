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
import { SupplicateQuoter__factory } from '../typechain-types/periphery'

import completeFixture from './shared/completeFixture.ts'
import { FeeAmount, MaxUint128 } from './shared/constants.ts'
import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'
import { expandTo18Decimals } from './shared/expandTo18Decimals.ts'
import { encodePath } from './shared/path.ts'
import { createPool } from './shared/quoter.ts' // keep using your helper

describe('SupplicateQuoter', () => {
  let signer0: any
  let trader: any

  async function fixture() {
    const signers = await ethers.getSigners()
    ;[signer0, trader] = signers

    const { weth9, factory, router, tokens, nft } = await completeFixture(signers as any, ethers.provider as any)

    // approvals/funding for both signers
    for (const token of tokens) {
      await token.connect(signer0).approve(await router.getAddress(), ethers.MaxUint256)
      await token.connect(signer0).approve(await nft.getAddress(), ethers.MaxUint256)
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)
      await token.connect(signer0).transfer(await trader.getAddress(), expandTo18Decimals(1_000_000))
    }

    // typed deploy using TypeChain factory + v6 getAddress()
    const qFactory = new SupplicateQuoter__factory(signer0)
    const quoter = (await qFactory.deploy(
      await factory.getAddress(),
      await weth9.getAddress()
    )) as SupplicateQuoter
    await quoter.waitForDeployment()

    return { tokens, nft, quoter }
  }

  let nft: MockTimeNonfungiblePositionManager
  let tokens: [TestERC20, TestERC20, TestERC20]
  let quoter: SupplicateQuoter

  beforeEach(async () => {
    ;({ tokens, nft, quoter } = await loadFixture(fixture))
  })

  describe('quotes', () => {
    beforeEach(async () => {
      // create two pools using your helper
      await createPool(
        nft,
        signer0,
        await tokens[0].getAddress(),
        await tokens[1].getAddress()
      )
      await createPool(
        nft,
        signer0,
        await tokens[1].getAddress(),
        await tokens[2].getAddress()
      )
    })

    describe('#quoteExactInput', () => {
      it('0 -> 1', async () => {
        const quote = await quoter.quoteExactInput.staticCall(
          encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FeeAmount.ZERO]),
          3n
        )
        expect(quote).to.eq(1n)
      })

      it('1 -> 0', async () => {
        const quote = await quoter.quoteExactInput.staticCall(
          encodePath([await tokens[1].getAddress(), await tokens[0].getAddress()], [FeeAmount.ZERO]),
          3n
        )
        expect(quote).to.eq(1n)
      })

      it('0 -> 1 -> 2', async () => {
        const quote = await quoter.quoteExactInput.staticCall(
          encodePath(
            [await tokens[0].getAddress(), await tokens[1].getAddress(), await tokens[2].getAddress()],
            [FeeAmount.ZERO, FeeAmount.ZERO]
          ),
          5n
        )
        expect(quote).to.eq(1n)
      })

      it('2 -> 1 -> 0', async () => {
        const quote = await quoter.quoteExactInput.staticCall(
          encodePath(
            [await tokens[2].getAddress(), await tokens[1].getAddress(), await tokens[0].getAddress()],
            [FeeAmount.ZERO, FeeAmount.ZERO]
          ),
          5n
        )
        expect(quote).to.eq(1n)
      })
    })

    describe('#quoteExactInputSingle', () => {
      it('0 -> 1', async () => {
        const quote = await quoter.quoteExactInputSingle.staticCall(
          await tokens[0].getAddress(),
          await tokens[1].getAddress(),
          FeeAmount.ZERO,
          MaxUint128, // already a bigint from your shared constants
          // -2%
          encodePriceSqrt(100, 102)
        )
        expect(quote).to.eq(9852n)
      })

      it('1 -> 0', async () => {
        const quote = await quoter.quoteExactInputSingle.staticCall(
          await tokens[1].getAddress(),
          await tokens[0].getAddress(),
          FeeAmount.ZERO,
          MaxUint128,
          // +2%
          encodePriceSqrt(102, 100)
        )
        expect(quote).to.eq(9852n)
      })
    })

    describe('#quoteExactOutput', () => {
      it('0 -> 1', async () => {
        const quote = await quoter.quoteExactOutput.staticCall(
          encodePath([await tokens[1].getAddress(), await tokens[0].getAddress()], [FeeAmount.ZERO]),
          1n
        )
        expect(quote).to.eq(3n)
      })

      it('1 -> 0', async () => {
        const quote = await quoter.quoteExactOutput.staticCall(
          encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FeeAmount.ZERO]),
          1n
        )
        expect(quote).to.eq(3n)
      })

      it('0 -> 1 -> 2', async () => {
        const quote = await quoter.quoteExactOutput.staticCall(
          encodePath(
            [await tokens[2].getAddress(), await tokens[1].getAddress(), await tokens[0].getAddress()],
            [FeeAmount.ZERO, FeeAmount.ZERO]
          ),
          1n
        )
        expect(quote).to.eq(5n)
      })

      it('2 -> 1 -> 0', async () => {
        const quote = await quoter.quoteExactOutput.staticCall(
          encodePath(
            [await tokens[0].getAddress(), await tokens[1].getAddress(), await tokens[2].getAddress()],
            [FeeAmount.ZERO, FeeAmount.ZERO]
          ),
          1n
        )
        expect(quote).to.eq(5n)
      })
    })

    describe('#quoteExactOutputSingle', () => {
      it('0 -> 1', async () => {
        const quote = await quoter.quoteExactOutputSingle.staticCall(
          await tokens[0].getAddress(),
          await tokens[1].getAddress(),
          FeeAmount.ZERO,
          MaxUint128,
          encodePriceSqrt(100, 102)
        )
        expect(quote).to.eq(9981n)
      })

      it('1 -> 0', async () => {
        const quote = await quoter.quoteExactOutputSingle.staticCall(
          await tokens[1].getAddress(),
          await tokens[0].getAddress(),
          FeeAmount.ZERO,
          MaxUint128,
          encodePriceSqrt(102, 100)
        )
        expect(quote).to.eq(9981n)
      })
    })
  })
})