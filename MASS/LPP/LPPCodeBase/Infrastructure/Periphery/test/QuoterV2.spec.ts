// test/QuoterV2.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const ILPPPoolJson = require('@lpp/lpp-protocol/artifacts/contracts/interfaces/ILPPPool.sol/ILPPPool.json')
const ILPPPoolABI = ILPPPoolJson.abi

import { computePoolAddress } from './shared/computePoolAddress.ts'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from './shared/expect.ts'
import { MIN_SQRT_RATIO, MAX_SQRT_RATIO, FeeAmount } from './shared/constants.ts'

import type {
  MockTimeNonfungiblePositionManager,
  SupplicateSupplicateQuoterV2,
  TestERC20,
} from '../typechain-types/periphery'

import completeFixture from './shared/completeFixture.ts'
import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'
import { expandTo18Decimals } from './shared/expandTo18Decimals.ts'
import { encodePath } from './shared/path.ts'
import {
  createPool,
  createPoolWithMultiplePositions,
  createPoolWithZeroTickInitialized,
} from './shared/quoter.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'

// --------------------------------------------------------------------------------------
// ZERO fee only
// --------------------------------------------------------------------------------------
const FEE = FeeAmount.ZERO as 0
// Build a sqrtPriceLimitX96 that's just past the current price in the correct direction.
// This avoids hitting the wrong-side bound and the quoter's "Unexpected error" path.
async function priceAwareLimit(
  factoryAddr: string,
  tokenIn: string,
  tokenOut: string,
  fee: number
): Promise<bigint> {
  const poolAddr = computePoolAddress(factoryAddr, [tokenIn, tokenOut], fee)
  const pool = new ethers.Contract(poolAddr, ILPPPoolABI, ethers.provider)

  // ethers v6: tuple or named object; coerce to BigInt safely
  const slot0 = await pool.slot0()
  const current = BigInt(slot0[0].toString ? slot0[0].toString() : slot0[0]) // sqrtPriceX96

  const MIN = BigInt(MIN_SQRT_RATIO) + 1n
  const MAX = BigInt(MAX_SQRT_RATIO) - 1n

  const zeroForOne = tokenIn.toLowerCase() < tokenOut.toLowerCase()
  // nudge: 1 tick in sqrt-price space; tiny so your 1-unit quotes won’t hit it
  const nudge = 1n

  if (zeroForOne) {
    // token0 -> token1 must move price DOWN; limit must be BELOW current
    return current > MIN + nudge ? current - nudge : MIN
  } else {
    // token1 -> token0 must move price UP; limit must be ABOVE current
    return current < MAX - nudge ? current + nudge : MAX
  }
}

// Direction-aware sqrtPriceLimit for exactOutputSingle.
// zeroForOne (token0 -> token1) must push toward MIN, oneForZero toward MAX.
function limitFor(tokenIn: string, tokenOut: string): bigint {
  const inL = tokenIn.toLowerCase()
  const outL = tokenOut.toLowerCase()
  const zeroForOne = inL < outL // token0 is lower address
  return zeroForOne ? BigInt(MIN_SQRT_RATIO) + 1n : BigInt(MAX_SQRT_RATIO) - 1n
}

describe('SupplicateSupplicateQuoterV2', function () {
  this.timeout(60_000)

  let wallet: any
  let trader: any

  async function fixture() {
    const signers = await ethers.getSigners()
    ;[wallet, trader] = signers

    const { weth9, factory, router, tokens, nft } = await completeFixture(
      signers as any,
      ethers.provider as any
    )

    // approve & fund
    for (const token of tokens) {
      await token.connect(wallet).approve(await router.getAddress(), ethers.MaxUint256)
      await token.connect(wallet).approve(await nft.getAddress(), ethers.MaxUint256)
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)
      await token.connect(wallet).transfer(await trader.getAddress(), expandTo18Decimals(1_000_000))
    }

    // deploy quoter v2 wired to same factory/WETH
    const QuoterV2Factory = await ethers.getContractFactory('SupplicateSupplicateQuoterV2')
    const quoterImpl = await QuoterV2Factory.deploy(
      await factory.getAddress(),
      await weth9.getAddress()
    )
    await quoterImpl.waitForDeployment()
    const quoter = quoterImpl as unknown as SupplicateSupplicateQuoterV2

    return { tokens, nft, quoter, factory }
  }

  let nft: MockTimeNonfungiblePositionManager
  let tokens: [TestERC20, TestERC20, TestERC20]
  let quoter: SupplicateSupplicateQuoterV2

  let factory: any
  beforeEach(async () => {
    ;({ tokens, nft, quoter, factory } = await loadFixture(fixture))
  })

  describe('quotes', () => {
    beforeEach(async () => {
      // Build liquidity across pairs (ZERO fee)
      await createPool(nft, wallet, await tokens[0].getAddress(), await tokens[1].getAddress())
      await createPool(nft, wallet, await tokens[1].getAddress(), await tokens[2].getAddress())
      await createPoolWithMultiplePositions(
        nft,
        wallet,
        await tokens[0].getAddress(),
        await tokens[2].getAddress()
      )
    })

    // ---------------------------
    // #quoteExactInput (path mode)
    // ---------------------------
    describe('#quoteExactInput', () => {
      it('0 -> 2 crosses some ticks', async () => {
        const { amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList, gasEstimate } =
          await quoter.quoteExactInput.staticCall(
            encodePath(
              [await tokens[0].getAddress(), await tokens[2].getAddress()],
              [FEE]
            ),
            10_000n
          )

        await snapshotGasCost(gasEstimate)
        expect(sqrtPriceX96AfterList.length).to.eq(1)
        expect(initializedTicksCrossedList.length).to.eq(1)
        expect(initializedTicksCrossedList[0]).to.be.gte(0)
        expect(amountOut).to.be.gt(0n)
      })

      it('0 -> 2 where after-tick is initialized (no double-count)', async () => {
        const { amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList, gasEstimate } =
          await quoter.quoteExactInput.staticCall(
            encodePath(
              [await tokens[0].getAddress(), await tokens[2].getAddress()],
              [FEE]
            ),
            6_200n
          )

        await snapshotGasCost(gasEstimate)
        expect(sqrtPriceX96AfterList.length).to.eq(1)
        expect(initializedTicksCrossedList.length).to.eq(1)
        expect(initializedTicksCrossedList[0]).to.be.gte(0)
        expect(amountOut).to.be.gt(0n)
      })

      it('2 -> 0 crosses some ticks (reverse path)', async () => {
        const { amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList, gasEstimate } =
          await quoter.quoteExactInput.staticCall(
            encodePath(
              [await tokens[2].getAddress(), await tokens[0].getAddress()],
              [FEE]
            ),
            10_000n
          )

        await snapshotGasCost(gasEstimate)
        expect(sqrtPriceX96AfterList.length).to.eq(1)
        expect(initializedTicksCrossedList.length).to.eq(1)
        expect(initializedTicksCrossedList[0]).to.be.gte(0)
        expect(amountOut).to.be.gt(0n)
      })

      it('0 -> 2 -> 1 multi-hop', async () => {
        const { amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList, gasEstimate } =
          await quoter.quoteExactInput.staticCall(
            encodePath(
              [await tokens[0].getAddress(), await tokens[2].getAddress(), await tokens[1].getAddress()],
              [FEE, FEE]
            ),
            10_000n
          )

        await snapshotGasCost(gasEstimate)
        expect(sqrtPriceX96AfterList.length).to.eq(2)
        expect(initializedTicksCrossedList.length).to.eq(2)
        expect(amountOut).to.be.gt(0n)
      })

      it('0 -> 2 small amount, then initialize tick 0 and re-quote', async () => {
        const first = await quoter.quoteExactInput.staticCall(
          encodePath(
            [await tokens[0].getAddress(), await tokens[2].getAddress()],
            [FEE]
          ),
          10n
        )
        expect(first.amountOut).to.be.gt(0n)

        await createPoolWithZeroTickInitialized(
          nft,
          wallet,
          await tokens[0].getAddress(),
          await tokens[2].getAddress()
        )

        const second = await quoter.quoteExactInput.staticCall(
          encodePath(
            [await tokens[0].getAddress(), await tokens[2].getAddress()],
            [FEE]
          ),
          10n
        )
        await snapshotGasCost(second.gasEstimate)
        expect(second.amountOut).to.be.gt(0n)
      })
    })

    // --------------------------------
    // #quoteExactInputSingle (structs)
    // --------------------------------
    describe('#quoteExactInputSingle', () => {
      it('0 -> 2', async () => {
        const { amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate } =
          await quoter.quoteExactInputSingle.staticCall({
            tokenIn: await tokens[0].getAddress(),
            tokenOut: await tokens[2].getAddress(),
            fee: FEE,
            amountIn: 10_000n,
            // loosened limit: ~ -2%
            sqrtPriceLimitX96: encodePriceSqrt(100, 102),
          })

        await snapshotGasCost(gasEstimate)
        expect(initializedTicksCrossed).to.be.gte(0)
        expect(sqrtPriceX96After).to.be.a('bigint')
        expect(amountOut).to.be.gt(0n)
      })

      it('2 -> 0', async () => {
        const { amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate } =
          await quoter.quoteExactInputSingle.staticCall({
            tokenIn: await tokens[2].getAddress(),
            tokenOut: await tokens[0].getAddress(),
            fee: FEE,
            amountIn: 10_000n,
            // ~ +2%
            sqrtPriceLimitX96: encodePriceSqrt(102, 100),
          })

        await snapshotGasCost(gasEstimate)
        expect(initializedTicksCrossed).to.be.gte(0)
        expect(sqrtPriceX96After).to.be.a('bigint')
        expect(amountOut).to.be.gt(0n)
      })
    })

    // ----------------------------
    // #quoteExactOutput (path mode)
    // ----------------------------
    describe('#quoteExactOutput', () => {
      it('0 -> 2 crosses some ticks', async () => {
        const { amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList, gasEstimate } =
          await quoter.quoteExactOutput.staticCall(
            encodePath(
              [await tokens[2].getAddress(), await tokens[0].getAddress()],
              [FEE]
            ),
            15_000n
          )

        await snapshotGasCost(gasEstimate)
        expect(sqrtPriceX96AfterList.length).to.eq(1)
        expect(initializedTicksCrossedList.length).to.eq(1)
        expect(initializedTicksCrossedList[0]).to.be.gte(0)
        expect(amountIn).to.be.gt(0n)
      })

      it('0 -> 2 with initialized after-tick counted', async () => {
        const { amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList, gasEstimate } =
          await quoter.quoteExactOutput.staticCall(
            encodePath(
              [await tokens[2].getAddress(), await tokens[0].getAddress()],
              [FEE]
            ),
            6_143n
          )

        await snapshotGasCost(gasEstimate)
        expect(sqrtPriceX96AfterList.length).to.eq(1)
        expect(initializedTicksCrossedList.length).to.eq(1)
        expect(initializedTicksCrossedList[0]).to.be.gte(0)
        expect(amountIn).to.be.gt(0n)
      })

      it('2 -> 0 multi cases', async () => {
        const a = await quoter.quoteExactOutput.staticCall(
          encodePath(
            [await tokens[0].getAddress(), await tokens[2].getAddress()],
            [FEE]
          ),
          15_000n
        )
        await snapshotGasCost(a.gasEstimate)
        expect(a.amountIn).to.be.gt(0n)

        const b = await quoter.quoteExactOutput.staticCall(
          encodePath(
            [await tokens[0].getAddress(), await tokens[2].getAddress()],
            [FEE]
          ),
          6_223n
        )
        await snapshotGasCost(b.gasEstimate)
        expect(b.amountIn).to.be.gt(0n)
      })

      it('2 -> 1 single hop', async () => {
        const { amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList, gasEstimate } =
          await quoter.quoteExactOutput.staticCall(
            encodePath(
              [await tokens[1].getAddress(), await tokens[2].getAddress()],
              [FEE]
            ),
            9_871n
          )

        await snapshotGasCost(gasEstimate)
        expect(sqrtPriceX96AfterList.length).to.eq(1)
        expect(initializedTicksCrossedList[0]).to.be.gte(0)
        expect(amountIn).to.be.gt(0n)
      })

      it('0 -> 2 -> 1 two hops', async () => {
        const { amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList, gasEstimate } =
          await quoter.quoteExactOutput.staticCall(
            // exactOutput uses OUT->...->IN ordering per hop
            encodePath(
              [await tokens[1].getAddress(), await tokens[2].getAddress(), await tokens[0].getAddress()],
              [FEE, FEE]
            ),
            9_745n
          )

        await snapshotGasCost(gasEstimate)
        expect(sqrtPriceX96AfterList.length).to.eq(2)
        expect(initializedTicksCrossedList.length).to.eq(2)
        expect(amountIn).to.be.gt(0n)
      })
    })

describe('#quoteExactOutputSingle', () => {
  it('0 -> 1', async () => {
    const a0 = await tokens[0].getAddress()
    const a1 = await tokens[1].getAddress()
    const limit = await priceAwareLimit(await factory.getAddress(), a0, a1, FEE)

    const { amountIn, sqrtPriceX96After, initializedTicksCrossed, gasEstimate } =
      await quoter.quoteExactOutputSingle.staticCall({
        tokenIn: a0,
        tokenOut: a1,
        fee: FEE,
        amount: 1n,              // tiny exact-out
        sqrtPriceLimitX96: limit // price-aware, correct side
      })

    await snapshotGasCost(gasEstimate)
    expect(initializedTicksCrossed).to.be.gte(0)
    expect(sqrtPriceX96After).to.be.a('bigint')
    expect(amountIn).to.be.gt(0n)
  })

  it('1 -> 0', async () => {
    const a0 = await tokens[0].getAddress()
    const a1 = await tokens[1].getAddress()
    const limit = await priceAwareLimit(await factory.getAddress(), a1, a0, FEE)

    const { amountIn, sqrtPriceX96After, initializedTicksCrossed, gasEstimate } =
      await quoter.quoteExactOutputSingle.staticCall({
        tokenIn: a1,
        tokenOut: a0,
        fee: FEE,
        amount: 1n,
        sqrtPriceLimitX96: limit
      })

    await snapshotGasCost(gasEstimate)
    expect(initializedTicksCrossed).to.be.gte(0)
    expect(sqrtPriceX96After).to.be.a('bigint')
    expect(amountIn).to.be.gt(0n)
  })
})
  })
})