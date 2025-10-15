// test/PoolTicksCounter.spec.ts
import hre from 'hardhat'
const { ethers, artifacts } = hre
import { expect } from './shared/expect'

// waffle mock utils (still fine to use with HH)
// NOTE: don't import Fixture here—we're not using it
import { deployMockContract, type MockContract } from 'ethereum-waffle'
import type { Artifact } from 'hardhat/types'

import type { PoolTicksCounterTest } from '../typechain-types/periphery'

// Pull v6 constants from ethers
import { MaxUint256 } from 'ethers'

describe('PoolTicksCounter', () => {
  // try a couple spacings to exercise the bitmap logic
  const TICK_SPACINGS = [200, 60, 10]

  TICK_SPACINGS.forEach((TICK_SPACING) => {
    let PoolTicksCounter: PoolTicksCounterTest
    let pool: MockContract
    let PoolAbi: Artifact

    // Bit index to tick
    const bitIdxToTick = (idx: number, page = 0) => {
      return idx * TICK_SPACING + page * 256 * TICK_SPACING
    }

    before(async () => {
      const [signer] = await ethers.getSigners()

      PoolAbi = await artifacts.readArtifact('ILPPPool')

      const factory = await ethers.getContractFactory('PoolTicksCounterTest')
      const deployed = await factory.deploy()
      await deployed.waitForDeployment()
      PoolTicksCounter = deployed as unknown as PoolTicksCounterTest

      pool = await deployMockContract(signer as any, PoolAbi.abi)
      await pool.mock.tickSpacing.returns(TICK_SPACING)
    })

    describe(`[Tick Spacing: ${TICK_SPACING}]: tick after is bigger`, () => {
      it('same tick initialized', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b1100)
        const result = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(2),
          bitIdxToTick(2)
        )
        expect(result).to.eq(1)
      })

      it('same tick not-initialized', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b1100)
        const result = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(1),
          bitIdxToTick(1)
        )
        expect(result).to.eq(0)
      })

      it('same page', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b1100)
        const result = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(0),
          bitIdxToTick(255)
        )
        expect(result).to.eq(2)
      })

      it('multiple pages', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b1100)
        await pool.mock.tickBitmap.withArgs(1).returns(0b1101)
        const result = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(0),
          bitIdxToTick(255, 1)
        )
        expect(result).to.eq(5)
      })

      it('counts all ticks in a page except ending tick', async () => {
        // ethers v6: use MaxUint256 (bigint), not ethers.constants.MaxUint256
        await pool.mock.tickBitmap.withArgs(0).returns(MaxUint256)
        await pool.mock.tickBitmap.withArgs(1).returns(0x0)
        const result = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(0),
          bitIdxToTick(255, 1)
        )
        expect(result).to.eq(255)
      })

      it('counts ticks to left of start and right of end on same page', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b1111000100001111)
        const result = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(8),
          bitIdxToTick(255)
        )
        expect(result).to.eq(4)
      })

      it('counts ticks to left of start and right of end across multiple pages', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b1111000100001111)
        await pool.mock.tickBitmap.withArgs(1).returns(0b1111000100001111)
        const result = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(8),
          bitIdxToTick(8, 1)
        )
        expect(result).to.eq(9)
      })

      it('counts when before and after are initialized on same page', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b11111100)
        const startingTickInit = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(2),
          bitIdxToTick(255)
        )
        expect(startingTickInit).to.eq(5)

        const endingTickInit = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(0),
          bitIdxToTick(3)
        )
        expect(endingTickInit).to.eq(2)

        const bothInit = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(2),
          bitIdxToTick(5)
        )
        expect(bothInit).to.eq(3)
      })

      it('counts when before and after are initialized on multiple pages', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b11111100)
        await pool.mock.tickBitmap.withArgs(1).returns(0b11111100)
        const startingTickInit = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(2),
          bitIdxToTick(255)
        )
        expect(startingTickInit).to.eq(5)

        const endingTickInit = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(0),
          bitIdxToTick(3, 1)
        )
        expect(endingTickInit).to.eq(8)

        const bothInit = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(2),
          bitIdxToTick(5, 1)
        )
        expect(bothInit).to.eq(9)
      })

      it('counts with lots of pages', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b11111100)
        await pool.mock.tickBitmap.withArgs(1).returns(0b11111111)
        await pool.mock.tickBitmap.withArgs(2).returns(0x0)
        await pool.mock.tickBitmap.withArgs(3).returns(0x0)
        await pool.mock.tickBitmap.withArgs(4).returns(0b11111100)

        const bothInit = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(4),
          bitIdxToTick(5, 4)
        )
        expect(bothInit).to.eq(15)
      })
    })

    describe(`[Tick Spacing: ${TICK_SPACING}]: tick after is smaller`, () => {
      it('same page', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b1100)
        const result = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(255),
          bitIdxToTick(0)
        )
        expect(result).to.eq(2)
      })

      it('multiple pages', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b1100)
        await pool.mock.tickBitmap.withArgs(-1).returns(0b1100)
        const result = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(255),
          bitIdxToTick(0, -1)
        )
        expect(result).to.eq(4)
      })

      it('counts all ticks in a page', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(MaxUint256)
        await pool.mock.tickBitmap.withArgs(-1).returns(0x0)
        const result = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(255),
          bitIdxToTick(0, -1)
        )
        expect(result).to.eq(256)
      })

      it('counts ticks to right of start and left of end on same page', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b1111000100001111)
        const result = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(15),
          bitIdxToTick(2)
        )
        expect(result).to.eq(6)
      })

      it('counts ticks to right of start and left of end on multiple pages', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b1111000100001111)
        await pool.mock.tickBitmap.withArgs(-1).returns(0b1111000100001111)
        const result = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(8),
          bitIdxToTick(8, -1)
        )
        expect(result).to.eq(9)
      })

      it('counts when before and after are initialized on same page', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b11111100)
        const startingTickInit = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(3),
          bitIdxToTick(0)
        )
        expect(startingTickInit).to.eq(2)

        const endingTickInit = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(255),
          bitIdxToTick(2)
        )
        expect(endingTickInit).to.eq(5)

        const bothInit = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(5),
          bitIdxToTick(2)
        )
        expect(bothInit).to.eq(3)
      })

      it('counts when before and after are initialized on multiple pages', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b11111100)
        await pool.mock.tickBitmap.withArgs(-1).returns(0b11111100)
        const startingTickInit = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(2),
          bitIdxToTick(3, -1)
        )
        expect(startingTickInit).to.eq(5)

        const endingTickInit = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(5),
          bitIdxToTick(255, -1)
        )
        expect(endingTickInit).to.eq(4)

        const bothInit = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(2),
          bitIdxToTick(5, -1)
        )
        expect(bothInit).to.eq(3)
      })

      it('counts with lots of pages', async () => {
        await pool.mock.tickBitmap.withArgs(0).returns(0b11111100)
        await pool.mock.tickBitmap.withArgs(-1).returns(0xff)
        await pool.mock.tickBitmap.withArgs(-2).returns(0x0)
        await pool.mock.tickBitmap.withArgs(-3).returns(0x0)
        await pool.mock.tickBitmap.withArgs(-4).returns(0b11111100)

        const bothInit = await PoolTicksCounter.countInitializedTicksCrossed(
          pool.address,
          bitIdxToTick(3),
          bitIdxToTick(6, -4)
        )
        expect(bothInit).to.eq(11)
      })
    })
  })
})