// test/PositionValue.spec.ts
import hre from 'hardhat'
const { ethers } = hre
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'

import { expect } from './shared/expect.ts'
import type {
  PositionValueTest,
  SupplicateRouter,
  MockTimeNonfungiblePositionManager,
  TestERC20,
} from '../typechain-types/periphery'
import type { ILPPFactory } from '../typechain-types/protocol'

import { MaxUint256, type BigNumberish, Contract } from 'ethers'
import { FeeAmount, MaxUint128, TICK_SPACINGS } from './shared/constants.ts'
import { getMaxTick, getMinTick } from './shared/ticks.ts'
import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'
import { expandTo18Decimals } from './shared/expandTo18Decimals.ts'
import { encodePath } from './shared/path.ts'
import { computePoolAddress } from './shared/computePoolAddress.ts'
import completeFixture from './shared/completeFixture.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'

// ESM-safe artifact import
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const ILPPPoolABI = require('@lpp/lpp-protocol/artifacts/contracts/interfaces/ILPPPool.sol/ILPPPool.json').abi

const FAR_DEADLINE = 1_000_000_000 // keep deadlines safely in the future
const TOL = 2_000n                 // tiny tolerance for rounding differences (wei)

// small helper for bigint closeness
function expectClose(actual: bigint, expected: bigint, tol: bigint = TOL) {
  const diff = actual > expected ? actual - expected : expected - actual
  expect(diff <= tol, `|${actual} - ${expected}| = ${diff} > ${tol}`).to.equal(true)
}

describe('PositionValue', () => {
  let pool: Contract
  let tokens: [TestERC20, TestERC20, TestERC20]
  let positionValue: PositionValueTest
  let nft: MockTimeNonfungiblePositionManager
  let router: SupplicateRouter
  let factory: ILPPFactory
  let amountDesired: BigNumberish

  async function positionValueCompleteFixture() {
    const signers = await ethers.getSigners()
    const { nft, router, tokens, factory } = await completeFixture(signers as any, ethers.provider)

    const positionValueFactory = await ethers.getContractFactory('PositionValueTest')
    const deployed = await positionValueFactory.deploy()
    await deployed.waitForDeployment()
    const positionValue = deployed as unknown as PositionValueTest

    for (const token of tokens) {
      await token.approve(await nft.getAddress(), MaxUint256)
      await token.connect(signers[0]).approve(await nft.getAddress(), MaxUint256)
      await token.transfer(await signers[0].getAddress(), expandTo18Decimals(1_000_000))
    }

    return { positionValue, tokens, nft, router, factory }
  }

  beforeEach(async () => {
    ;({ positionValue, tokens, nft, router, factory } = await loadFixture(positionValueCompleteFixture))

    await nft.createAndInitializePoolIfNecessary(
      await tokens[0].getAddress(),
      await tokens[1].getAddress(),
      FeeAmount.ZERO,
      encodePriceSqrt(1, 1)
    )

    const poolAddress = computePoolAddress(
      await factory.getAddress(),
      [await tokens[0].getAddress(), await tokens[1].getAddress()],
      FeeAmount.ZERO
    )

    const [signer0] = await ethers.getSigners()
    pool = new ethers.Contract(poolAddress, ILPPPoolABI, signer0)
  })

  describe('#total', () => {
    let sqrtRatioX96: BigNumberish

    beforeEach(async () => {
      const [signer0] = await ethers.getSigners()
      amountDesired = expandTo18Decimals(100_000)

      await nft.mint({
        token0: await tokens[0].getAddress(),
        token1: await tokens[1].getAddress(),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        fee: FeeAmount.ZERO,
        recipient: await signer0.getAddress(),
        amount0Desired: amountDesired,
        amount1Desired: amountDesired,
        amount0Min: 0,
        amount1Min: 0,
        deadline: FAR_DEADLINE,
      })

      const swapAmount = expandTo18Decimals(1_000)
      await tokens[0].approve(await router.getAddress(), swapAmount)
      await tokens[1].approve(await router.getAddress(), swapAmount)

      // accumulate token0 fees
      await router.exactInput({
        recipient: await signer0.getAddress(),
        deadline: FAR_DEADLINE,
        path: encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FeeAmount.ZERO]),
        amountIn: swapAmount,
        amountOutMinimum: 0,
      })

      // accumulate token1 fees
      await router.exactInput({
        recipient: await signer0.getAddress(),
        deadline: FAR_DEADLINE,
        path: encodePath([await tokens[1].getAddress(), await tokens[0].getAddress()], [FeeAmount.ZERO]),
        amountIn: swapAmount,
        amountOutMinimum: 0,
      })

      sqrtRatioX96 = (await pool.slot0()).sqrtPriceX96
    })

    it('returns the correct amount', async () => {
      const principal = await positionValue.principal(await nft.getAddress(), 1, sqrtRatioX96)
      const fees = await positionValue.fees(await nft.getAddress(), 1)
      const total = await positionValue.total(await nft.getAddress(), 1, sqrtRatioX96)

      expect(total[0]).to.equal(principal[0] + fees[0])
      expect(total[1]).to.equal(principal[1] + fees[1])
    })

    it('gas', async () => {
      await snapshotGasCost(positionValue.totalGas(await nft.getAddress(), 1, sqrtRatioX96))
    })
  })

  describe('#principal', () => {
    let sqrtRatioX96: BigNumberish

    beforeEach(async () => {
      amountDesired = expandTo18Decimals(100_000)
      sqrtRatioX96 = (await pool.slot0()).sqrtPriceX96
    })

    it('returns the correct values when price is in the middle of the range', async () => {
      const [signer0] = await ethers.getSigners()
      await nft.mint({
        token0: await tokens[0].getAddress(),
        token1: await tokens[1].getAddress(),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        fee: FeeAmount.ZERO,
        recipient: await signer0.getAddress(),
        amount0Desired: amountDesired,
        amount1Desired: amountDesired,
        amount0Min: 0,
        amount1Min: 0,
        deadline: FAR_DEADLINE,
      })

      const principal = await positionValue.principal(await nft.getAddress(), 1, sqrtRatioX96)
      expectClose(principal.amount0, 99999999999999999999999n)
      expectClose(principal.amount1, 99999999999999999999999n)
    })

    it('returns the correct values when range is below current price', async () => {
      const [signer0] = await ethers.getSigners()
      await nft.mint({
        token0: await tokens[0].getAddress(),
        token1: await tokens[1].getAddress(),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: -60,
        fee: FeeAmount.ZERO,
        recipient: await signer0.getAddress(),
        amount0Desired: amountDesired,
        amount1Desired: amountDesired,
        amount0Min: 0,
        amount1Min: 0,
        deadline: FAR_DEADLINE,
      })

      const principal = await positionValue.principal(await nft.getAddress(), 1, sqrtRatioX96)
      expect(principal.amount0).to.equal(0n)
      expectClose(principal.amount1, 99999999999999999999999n)
    })

    it('returns the correct values when range is above current price', async () => {
      const [signer0] = await ethers.getSigners()
      await nft.mint({
        token0: await tokens[0].getAddress(),
        token1: await tokens[1].getAddress(),
        tickLower: 60,
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        fee: FeeAmount.ZERO,
        recipient: await signer0.getAddress(),
        amount0Desired: amountDesired,
        amount1Desired: amountDesired,
        amount0Min: 0,
        amount1Min: 0,
        deadline: FAR_DEADLINE,
      })

      const principal = await positionValue.principal(await nft.getAddress(), 1, sqrtRatioX96)
      expectClose(principal.amount0, 99999999999999999999999n)
      expect(principal.amount1).to.equal(0n)
    })

    it('returns the correct values when range is skewed above price', async () => {
      const [signer0] = await ethers.getSigners()
      await nft.mint({
        token0: await tokens[0].getAddress(),
        token1: await tokens[1].getAddress(),
        tickLower: -6_000,
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        fee: FeeAmount.ZERO,
        recipient: await signer0.getAddress(),
        amount0Desired: amountDesired,
        amount1Desired: amountDesired,
        amount0Min: 0,
        amount1Min: 0,
        deadline: FAR_DEADLINE,
      })

      const principal = await positionValue.principal(await nft.getAddress(), 1, sqrtRatioX96)
      expectClose(principal.amount0, 99999999999999999999999n)
      expectClose(principal.amount1, 25917066770240321655335n)
    })

    it('returns the correct values when range is skewed below price', async () => {
      const [signer0] = await ethers.getSigners()
      await nft.mint({
        token0: await tokens[0].getAddress(),
        token1: await tokens[1].getAddress(),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: 6_000,
        fee: FeeAmount.ZERO,
        recipient: await signer0.getAddress(),
        amount0Desired: amountDesired,
        amount1Desired: amountDesired,
        amount0Min: 0,
        amount1Min: 0,
        deadline: FAR_DEADLINE,
      })

      const principal = await positionValue.principal(await nft.getAddress(), 1, sqrtRatioX96)
      expectClose(principal.amount0, 25917066770240321655335n)
      expectClose(principal.amount1, 99999999999999999999999n)
    })

    it('gas', async () => {
      // Mint once so tokenId 1 exists for principalGas
      const [signer0] = await ethers.getSigners()
      await nft.mint({
        token0: await tokens[0].getAddress(),
        token1: await tokens[1].getAddress(),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        fee: FeeAmount.ZERO,
        recipient: await signer0.getAddress(),
        amount0Desired: amountDesired,
        amount1Desired: amountDesired,
        amount0Min: 0,
        amount1Min: 0,
        deadline: FAR_DEADLINE,
      })

      await snapshotGasCost(positionValue.principalGas(await nft.getAddress(), 1, sqrtRatioX96))
    })
  })

  describe('#fees', () => {
    const tokenId = 2

    beforeEach(async () => {
      const [signer0] = await ethers.getSigners()
      amountDesired = expandTo18Decimals(100_000)

      await nft.mint({
        token0: await tokens[0].getAddress(),
        token1: await tokens[1].getAddress(),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        fee: FeeAmount.ZERO,
        recipient: await signer0.getAddress(),
        amount0Desired: amountDesired,
        amount1Desired: amountDesired,
        amount0Min: 0,
        amount1Min: 0,
        deadline: FAR_DEADLINE,
      })
    })

    describe('when price is within the position range', () => {
      beforeEach(async () => {
        const [signer0] = await ethers.getSigners()
        await nft.mint({
          token0: await tokens[0].getAddress(),
          token1: await tokens[1].getAddress(),
          tickLower: TICK_SPACINGS[FeeAmount.ZERO] * -1_000,
          tickUpper: TICK_SPACINGS[FeeAmount.ZERO] * 1_000,
          fee: FeeAmount.ZERO,
          recipient: await signer0.getAddress(),
          amount0Desired: amountDesired,
          amount1Desired: amountDesired,
          amount0Min: 0,
          amount1Min: 0,
          deadline: FAR_DEADLINE,
        })

        const swapAmount = expandTo18Decimals(1_000)
        await tokens[0].approve(await router.getAddress(), swapAmount)
        await tokens[1].approve(await router.getAddress(), swapAmount)

        await router.exactInput({
          recipient: await signer0.getAddress(),
          deadline: FAR_DEADLINE,
          path: encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FeeAmount.ZERO]),
          amountIn: swapAmount,
          amountOutMinimum: 0,
        })

        await router.exactInput({
          recipient: await signer0.getAddress(),
          deadline: FAR_DEADLINE,
          path: encodePath([await tokens[1].getAddress(), await tokens[0].getAddress()], [FeeAmount.ZERO]),
          amountIn: swapAmount,
          amountOutMinimum: 0,
        })
      })

      it('return the correct amount of fees', async () => {
        const [signer0] = await ethers.getSigners()
        const feesFromCollect = await nft.collect.staticCall({
          tokenId,
          recipient: await signer0.getAddress(),
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
        const feeAmounts = await positionValue.fees(await nft.getAddress(), tokenId)
        expect(feeAmounts[0]).to.equal(feesFromCollect[0])
        expect(feeAmounts[1]).to.equal(feesFromCollect[1])
      })

      it('returns the correct amount if tokensOwed fields are > 0', async () => {
        await nft.increaseLiquidity({
          tokenId,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: FAR_DEADLINE,
        })

        const [signer0] = await ethers.getSigners()
        const swapAmount = expandTo18Decimals(1_000)
        await tokens[0].approve(await router.getAddress(), swapAmount)

        await router.exactInput({
          recipient: await signer0.getAddress(),
          deadline: FAR_DEADLINE,
          path: encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FeeAmount.ZERO]),
          amountIn: swapAmount,
          amountOutMinimum: 0,
        })

        const feesFromCollect = await nft.collect.staticCall({
          tokenId,
          recipient: await signer0.getAddress(),
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
        const feeAmounts = await positionValue.fees(await nft.getAddress(), tokenId)
        expect(feeAmounts[0]).to.equal(feesFromCollect[0])
        expect(feeAmounts[1]).to.equal(feesFromCollect[1])
      })

      it('gas', async () => {
        await snapshotGasCost(positionValue.feesGas(await nft.getAddress(), tokenId))
      })
    })

    describe('when price is below the position range', () => {
      beforeEach(async () => {
        const [signer0] = await ethers.getSigners()
        await nft.mint({
          token0: await tokens[0].getAddress(),
          token1: await tokens[1].getAddress(),
          tickLower: TICK_SPACINGS[FeeAmount.ZERO] * -10,
          tickUpper: TICK_SPACINGS[FeeAmount.ZERO] * 10,
          fee: FeeAmount.ZERO,
          recipient: await signer0.getAddress(),
          amount0Desired: expandTo18Decimals(10_000),
          amount1Desired: expandTo18Decimals(10_000),
          amount0Min: 0,
          amount1Min: 0,
          deadline: FAR_DEADLINE,
        })

        await tokens[0].approve(await router.getAddress(), MaxUint256)
        await tokens[1].approve(await router.getAddress(), MaxUint256)

        // accumulate token1 fees
        await router.exactInput({
          recipient: await signer0.getAddress(),
          deadline: FAR_DEADLINE,
          path: encodePath([await tokens[1].getAddress(), await tokens[0].getAddress()], [FeeAmount.ZERO]),
          amountIn: expandTo18Decimals(1_000),
          amountOutMinimum: 0,
        })

        // accumulate token0 fees and push price below tickLower
        await router.exactInput({
          recipient: await signer0.getAddress(),
          deadline: FAR_DEADLINE,
          path: encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FeeAmount.ZERO]),
          amountIn: expandTo18Decimals(50_000),
          amountOutMinimum: 0,
        })
      })

      it('returns the correct amount of fees', async () => {
        const [signer0] = await ethers.getSigners()
        const feesFromCollect = await nft.collect.staticCall({
          tokenId,
          recipient: await signer0.getAddress(),
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })

        const feeAmounts = await positionValue.fees(await nft.getAddress(), tokenId)
        expect(feeAmounts[0]).to.equal(feesFromCollect[0])
        expect(feeAmounts[1]).to.equal(feesFromCollect[1])
      })

      it('gas', async () => {
        await snapshotGasCost(positionValue.feesGas(await nft.getAddress(), tokenId))
      })
    })

    describe('when price is above the position range', () => {
      beforeEach(async () => {
        const [signer0] = await ethers.getSigners()
        await nft.mint({
          token0: await tokens[0].getAddress(),
          token1: await tokens[1].getAddress(),
          tickLower: TICK_SPACINGS[FeeAmount.ZERO] * -10,
          tickUpper: TICK_SPACINGS[FeeAmount.ZERO] * 10,
          fee: FeeAmount.ZERO,
          recipient: await signer0.getAddress(),
          amount0Desired: expandTo18Decimals(10_000),
          amount1Desired: expandTo18Decimals(10_000),
          amount0Min: 0,
          amount1Min: 0,
          deadline: FAR_DEADLINE,
        })

        await tokens[0].approve(await router.getAddress(), MaxUint256)
        await tokens[1].approve(await router.getAddress(), MaxUint256)

        // accumulate token0 fees
        await router.exactInput({
          recipient: await signer0.getAddress(),
          deadline: FAR_DEADLINE,
          path: encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FeeAmount.ZERO]),
          amountIn: expandTo18Decimals(1_000),
          amountOutMinimum: 0,
        })

        // accumulate token1 fees and push price above tickUpper
        await router.exactInput({
          recipient: await signer0.getAddress(),
          deadline: FAR_DEADLINE,
          path: encodePath([await tokens[1].getAddress(), await tokens[0].getAddress()], [FeeAmount.ZERO]),
          amountIn: expandTo18Decimals(50_000),
          amountOutMinimum: 0,
        })
      })

      it('returns the correct amount of fees', async () => {
        const [signer0] = await ethers.getSigners()
        const feesFromCollect = await nft.collect.staticCall({
          tokenId,
          recipient: await signer0.getAddress(),
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
        const feeAmounts = await positionValue.fees(await nft.getAddress(), tokenId)
        expect(feeAmounts[0]).to.equal(feesFromCollect[0])
        expect(feeAmounts[1]).to.equal(feesFromCollect[1])
      })

      it('gas', async () => {
        await snapshotGasCost(positionValue.feesGas(await nft.getAddress(), tokenId))
      })
    })
  })
})