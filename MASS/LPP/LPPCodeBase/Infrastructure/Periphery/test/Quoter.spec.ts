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
import { FeeAmount, MaxUint128 } from './shared/constants.ts'
import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'
import { expandTo18Decimals } from './shared/expandTo18Decimals.ts'
import { encodePath } from './shared/path.ts'
import { createPool } from './shared/quoter.ts'


const SUPPLICATE_QUOTER_MIN_ABI = [
  'function quoteExactInput(bytes path, uint256 amountIn) view returns (uint256 amountOut)',
  'function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint128 amountIn,uint160 sqrtPriceLimitX96) view returns (uint256 amountOut)',
  'function quoteExactOutput(bytes path, uint256 amountOut) view returns (uint256 amountIn)',
  'function quoteExactOutputSingle(address tokenIn,address tokenOut,uint24 fee,uint128 amountOut,uint160 sqrtPriceLimitX96) view returns (uint256 amountIn)',
] as const

describe('SupplicateQuoter', () => {
  let signer0: any
  let trader: any

  async function fixture() {
    const signers = await ethers.getSigners()
    ;[signer0, trader] = signers

    // we still read factory & weth9 from the fixture (addresses only), no type import needed
    const { weth9, factory, router, tokens, nft } = await completeFixture(signers as any, ethers.provider as any)

    // approvals/funding
    for (const token of tokens) {
      await token.connect(signer0).approve(await router.getAddress(), ethers.MaxUint256)
      await token.connect(signer0).approve(await nft.getAddress(), ethers.MaxUint256)
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)
      await token.connect(signer0).transfer(await trader.getAddress(), expandTo18Decimals(1_000_000))
    }

    // deploy quoter impl
    const qFactory = await ethers.getContractFactory('SupplicateQuoter')
    const impl = await qFactory.deploy(await factory.getAddress(), await weth9.getAddress())
    await impl.waitForDeployment()

    // wrap impl with minimal ABI under signer0
    const quoter = new ethers.Contract(
      await impl.getAddress(),
      SUPPLICATE_QUOTER_MIN_ABI,
      signer0
    ) as unknown as SupplicateQuoter

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
        const quote = await (quoter as any).quoteExactInput.staticCall(
          encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FeeAmount.ZERO]),
          3n
        )
        expect(quote).to.equal(1n)
      })

      it('1 -> 0', async () => {
        const quote = await (quoter as any).quoteExactInput.staticCall(
          encodePath([await tokens[1].getAddress(), await tokens[0].getAddress()], [FeeAmount.ZERO]),
          3n
        )
        expect(quote).to.equal(1n)
      })

      it('0 -> 1 -> 2', async () => {
        const quote = await (quoter as any).quoteExactInput.staticCall(
          encodePath(
            [await tokens[0].getAddress(), await tokens[1].getAddress(), await tokens[2].getAddress()],
            [FeeAmount.ZERO, FeeAmount.ZERO]
          ),
          5n
        )
        expect(quote).to.equal(1n)
      })

      it('2 -> 1 -> 0', async () => {
        const quote = await (quoter as any).quoteExactInput.staticCall(
          encodePath(
            [await tokens[2].getAddress(), await tokens[1].getAddress(), await tokens[0].getAddress()],
            [FeeAmount.ZERO, FeeAmount.ZERO]
          ),
          5n
        )
        expect(quote).to.equal(1n)
      })
    })

    describe('#quoteExactInputSingle', () => {
      it('0 -> 1', async () => {
        const quote = await (quoter as any).quoteExactInputSingle.staticCall(
          await tokens[0].getAddress(),
          await tokens[1].getAddress(),
          FeeAmount.ZERO,
          MaxUint128,
          encodePriceSqrt(100, 102)
        )
        expect(quote).to.equal(9852n)
      })

      it('1 -> 0', async () => {
        const quote = await (quoter as any).quoteExactInputSingle.staticCall(
          await tokens[1].getAddress(),
          await tokens[0].getAddress(),
          FeeAmount.ZERO,
          MaxUint128,
          encodePriceSqrt(102, 100)
        )
        expect(quote).to.equal(9852n)
      })
    })

    describe('#quoteExactOutput', () => {
      it('0 -> 1', async () => {
        const quote = await (quoter as any).quoteExactOutput.staticCall(
          encodePath([await tokens[1].getAddress(), await tokens[0].getAddress()], [FeeAmount.ZERO]),
          1n
        )
        expect(quote).to.equal(3n)
      })

      it('1 -> 0', async () => {
        const quote = await (quoter as any).quoteExactOutput.staticCall(
          encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FeeAmount.ZERO]),
          1n
        )
        expect(quote).to.equal(3n)
      })

      it('0 -> 1 -> 2', async () => {
        const quote = await (quoter as any).quoteExactOutput.staticCall(
          encodePath(
            [await tokens[2].getAddress(), await tokens[1].getAddress(), await tokens[0].getAddress()],
            [FeeAmount.ZERO, FeeAmount.ZERO]
          ),
          1n
        )
        expect(quote).to.equal(5n)
      })

      it('2 -> 1 -> 0', async () => {
        const quote = await (quoter as any).quoteExactOutput.staticCall(
          encodePath(
            [await tokens[0].getAddress(), await tokens[1].getAddress(), await tokens[2].getAddress()],
            [FeeAmount.ZERO, FeeAmount.ZERO]
          ),
          1n
        )
        expect(quote).to.equal(5n)
      })
    })

    describe('#quoteExactOutputSingle', () => {
      it('0 -> 1', async () => {
        const quote = await (quoter as any).quoteExactOutputSingle.staticCall(
          await tokens[0].getAddress(),
          await tokens[1].getAddress(),
          FeeAmount.ZERO,
          MaxUint128,
          encodePriceSqrt(100, 102)
        )
        expect(quote).to.equal(9981n)
      })

      it('1 -> 0', async () => {
        const quote = await (quoter as any).quoteExactOutputSingle.staticCall(
          await tokens[1].getAddress(),
          await tokens[0].getAddress(),
          FeeAmount.ZERO,
          MaxUint128,
          encodePriceSqrt(102, 100)
        )
        expect(quote).to.equal(9981n)
      })
    })
  })
})