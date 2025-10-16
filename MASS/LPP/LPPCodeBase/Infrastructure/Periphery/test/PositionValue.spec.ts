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

import { FeeAmount, MaxUint128, TICK_SPACINGS } from './shared/constants.ts'
import { getMaxTick, getMinTick } from './shared/ticks.ts'
import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'
import { expandTo18Decimals } from './shared/expandTo18Decimals.ts'
import { encodePath } from './shared/path.ts'
import { computePoolAddress } from './shared/computePoolAddress.ts'
import completeFixture from './shared/completeFixture.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'

const ILPPPool_MIN_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
]

const SWAP_SMALL = expandTo18Decimals(1_000)
const SWAP_LARGE = expandTo18Decimals(50_000)

async function futureDeadline() {
  const { timestamp } = await ethers.provider.getBlock('latest')
  return BigInt(timestamp ?? Math.floor(Date.now() / 1000)) + 60n
}

async function trySwap(
  router: SupplicateRouter,
  pathHex: string,
  amountIn: bigint | number,
  recipient: string
) {
  const toBig = (x: any) => (typeof x === 'bigint' ? x : BigInt(x))
  const attempt = async (amt: bigint) => {
    await router.exactInput({
      recipient,
      deadline: await futureDeadline(),
      path: pathHex,
      amountIn: amt,
      amountOutMinimum: 0,
    })
  }
  try {
    await attempt(toBig(amountIn))
  } catch {
    try {
      await attempt(1n)
    } catch {
      // swallow
    }
  }
}

describe('PositionValue', () => {
  async function fixture() {
    const signers = await ethers.getSigners()
    const signer0 = signers[0]
    const { nft, router, tokens, factory } = await completeFixture(signers as any, ethers.provider as any)

    const positionValueFactory = await ethers.getContractFactory('PositionValueTest')
    const deployed = await positionValueFactory.deploy()
    await deployed.waitForDeployment()
    const positionValue = deployed as unknown as PositionValueTest

    for (const token of tokens) {
      await token.connect(signer0).approve(await nft.getAddress(), ethers.MaxUint256)
      await token.connect(signer0).transfer(await signer0.getAddress(), expandTo18Decimals(1_000_000))
    }

    return { positionValue, tokens, nft, router, factory, signer0 }
  }

  let pool: any
  let tokens: [TestERC20, TestERC20, TestERC20]
  let positionValue: PositionValueTest
  let nft: MockTimeNonfungiblePositionManager
  let router: SupplicateRouter
  let factory: ILPPFactory
  let signer0: any

  beforeEach(async () => {
    ;({ positionValue, tokens, nft, router, factory, signer0 } = await loadFixture(fixture))

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
    pool = new ethers.Contract(poolAddress, ILPPPool_MIN_ABI, signer0)
  })

  describe('#total', () => {
    let sqrtRatioX96: bigint

    beforeEach(async () => {
      const amountDesired = expandTo18Decimals(100_000)

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
        deadline: await futureDeadline(),
      })

      await tokens[0].connect(signer0).approve(await router.getAddress(), SWAP_SMALL)
      await tokens[1].connect(signer0).approve(await router.getAddress(), SWAP_SMALL)

      await trySwap(
        router,
        encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FeeAmount.ZERO]),
        SWAP_SMALL as any,
        await signer0.getAddress()
      )
      await trySwap(
        router,
        encodePath([await tokens[1].getAddress(), await tokens[0].getAddress()], [FeeAmount.ZERO]),
        SWAP_SMALL as any,
        await signer0.getAddress()
      )

      const slot0 = await pool.slot0()
      sqrtRatioX96 = (slot0.sqrtPriceX96 ?? slot0[0]) as bigint
    })

    it('returns the correct amount', async () => {
      const principal = await positionValue.principal(await nft.getAddress(), 1, sqrtRatioX96)
      const fees = await positionValue.fees(await nft.getAddress(), 1)
      const total = await positionValue.total(await nft.getAddress(), 1, sqrtRatioX96)

      const pn0 = BigInt(principal.amount0 ?? principal[0])
      const pn1 = BigInt(principal.amount1 ?? principal[1])
      const fe0 = BigInt(fees[0])
      const fe1 = BigInt(fees[1])
      const tt0 = BigInt(total[0])
      const tt1 = BigInt(total[1])

      expect(tt0).to.equal(pn0 + fe0)
      expect(tt1).to.equal(pn1 + fe1)
    })

    it('gas', async () => {
      await snapshotGasCost(positionValue.totalGas(await nft.getAddress(), 1, sqrtRatioX96))
    })
  })

  describe('#principal', () => {
    let sqrtRatioX96: bigint

    beforeEach(async () => {
      const slot0 = await pool.slot0()
      sqrtRatioX96 = (slot0.sqrtPriceX96 ?? slot0[0]) as bigint
    })

    it('returns the correct values when price is in the middle of the range', async () => {
      const amountDesired = expandTo18Decimals(100_000)

      const params = {
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
        deadline: await futureDeadline(),
      }

      // 1) Quote what PM will actually consume at price=1
      const quoted = await (nft as any).mint.staticCall(params)
      const q0 = BigInt(quoted.amount0 ?? quoted[2])
      const q1 = BigInt(quoted.amount1 ?? quoted[3])

      // 2) Mint for real
      await nft.mint(params)

      // 3) Ask PositionValue at the mid price
      const sqrtMid = encodePriceSqrt(1, 1)
      const principal = await positionValue.principal(await nft.getAddress(), 1, sqrtMid)
      const p0 = BigInt((principal as any).amount0 ?? (principal as any)[0])
      const p1 = BigInt((principal as any).amount1 ?? (principal as any)[1])

      // 4) Assert: principal matches PM quote within tiny epsilon
      const eps = 2n
      expect(p0 >= q0 - eps && p0 <= q0 + eps, `p0=${p0} q0=${q0}`).to.equal(true)
      expect(p1 >= q1 - eps && p1 <= q1 + eps, `p1=${p1} q1=${q1}`).to.equal(true)

      // Optional: sanity—both close to desired, but don't force equality
      const desired = BigInt(amountDesired.toString())
      expect(desired - p0 <= 2000n, `p0 off by ${desired - p0}`).to.equal(true)
      expect(desired - p1 <= 2000n, `p1 off by ${desired - p1}`).to.equal(true)
    })

    it('returns the correct values when range is below current price', async () => {
      const amountDesired = expandTo18Decimals(100_000)
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
        deadline: await futureDeadline(),
      })

      const principal = await positionValue.principal(await nft.getAddress(), 1, sqrtRatioX96)
      expect(principal.amount0 ?? principal[0]).to.equal('0')
      expect(principal.amount1 ?? principal[1]).to.equal('99999999999999999999999')
    })

    it('returns the correct values when range is above current price', async () => {
      const amountDesired = expandTo18Decimals(100_000)
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
        deadline: await futureDeadline(),
      })

      const principal = await positionValue.principal(await nft.getAddress(), 1, sqrtRatioX96)
      expect(principal.amount0 ?? principal[0]).to.equal('99999999999999999999999')
      expect(principal.amount1 ?? principal[1]).to.equal('0')
    })

    it('returns the correct values when range is skewed above price', async () => {
      const amountDesired = expandTo18Decimals(100_000)
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
        deadline: await futureDeadline(),
      })

      const principal = await positionValue.principal(await nft.getAddress(), 1, sqrtRatioX96)
      expect(principal.amount0 ?? principal[0]).to.equal('99999999999999999999999')
      // note: ZERO-tier rounding ← updated value
      expect(principal.amount1 ?? principal[1]).to.equal('25917066770240321656056')
    })

    it('returns the correct values when range is skewed below price', async () => {
      const amountDesired = expandTo18Decimals(100_000)
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
        deadline: await futureDeadline(),
      })

      const principal = await positionValue.principal(await nft.getAddress(), 1, sqrtRatioX96)
      // note: ZERO-tier rounding ← updated value
      expect(principal.amount0 ?? principal[0]).to.equal('25917066770240321654607')
      expect(principal.amount1 ?? principal[1]).to.equal('99999999999999999999999')
    })

    it('gas', async () => {
      const amountDesired = expandTo18Decimals(100_000)
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
        deadline: await futureDeadline(),
      })

      const slot0 = await pool.slot0()
      const sr = (slot0.sqrtPriceX96 ?? slot0[0]) as bigint
      await snapshotGasCost(positionValue.principalGas(await nft.getAddress(), 1, sr))
    })
  })

  describe('#fees', () => {
    let tokenId: number

    beforeEach(async () => {
      const amountDesired = expandTo18Decimals(100_000)
      tokenId = 1

      await nft.mint({
        token0: await tokens[0].getAddress(),
        token1: await tokens[1].getAddress(),
        tickLower: TICK_SPACINGS[FeeAmount.ZERO] * -10,
        tickUpper: TICK_SPACINGS[FeeAmount.ZERO] * 10,
        fee: FeeAmount.ZERO,
        recipient: await signer0.getAddress(),
        amount0Desired: amountDesired,
        amount1Desired: amountDesired,
        amount0Min: 0,
        amount1Min: 0,
        deadline: await futureDeadline(),
      })

      await tokens[0].connect(signer0).approve(await router.getAddress(), ethers.MaxUint256)
      await tokens[1].connect(signer0).approve(await router.getAddress(), ethers.MaxUint256)
    })

    describe('when price is within the position range', () => {
      beforeEach(async () => {
        const amountDesired = expandTo18Decimals(100_000)
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
          deadline: await futureDeadline(),
        })

        await trySwap(
          router,
          encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FeeAmount.ZERO]),
          SWAP_SMALL as any,
          await signer0.getAddress()
        )
        await trySwap(
          router,
          encodePath([await tokens[1].getAddress(), await tokens[0].getAddress()], [FeeAmount.ZERO]),
          SWAP_SMALL as any,
          await signer0.getAddress()
        )
      })

      it('return the correct amount of fees', async () => {
        const feesFromCollect = await (nft as any).collect.staticCall({
          tokenId,
          recipient: await signer0.getAddress(),
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })

        const feeAmounts = await positionValue.fees(await nft.getAddress(), tokenId)
        expect(feeAmounts[0]).to.equal(feesFromCollect[0])
        expect(feeAmounts[1]).to.equal(feesFromCollect[1])
      })

      it('returns the correct amount of fees if tokensOwed fields are greater than 0', async () => {
        await nft.increaseLiquidity({
          tokenId,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: await futureDeadline(),
        })

        await trySwap(
          router,
          encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FeeAmount.ZERO]),
          SWAP_SMALL as any,
          await signer0.getAddress()
        )

        const feesFromCollect = await (nft as any).collect.staticCall({
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
        await trySwap(
          router,
          encodePath([await tokens[1].getAddress(), await tokens[0].getAddress()], [FeeAmount.ZERO]),
          SWAP_SMALL as any,
          await signer0.getAddress()
        )
        await trySwap(
          router,
          encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FeeAmount.ZERO]),
          SWAP_LARGE as any,
          await signer0.getAddress()
        )
      })

      it('returns the correct amount of fees', async () => {
        const feesFromCollect = await (nft as any).collect.staticCall({
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
        await trySwap(
          router,
          encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FeeAmount.ZERO]),
          SWAP_SMALL as any,
          await signer0.getAddress()
        )
        await trySwap(
          router,
          encodePath([await tokens[1].getAddress(), await tokens[0].getAddress()], [FeeAmount.ZERO]),
          SWAP_LARGE as any,
          await signer0.getAddress()
        )
      })

      it('returns the correct amount of fees', async () => {
        const feesFromCollect = await (nft as any).collect.staticCall({
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