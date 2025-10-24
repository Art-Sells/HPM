// test/Tick.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import type { TickTest } from '../typechain-types/protocol'
import { expect } from './shared/expect.ts'
import { FeeAmount, getMaxLiquidityPerTick, TICK_SPACINGS } from './shared/utilities.ts'

// v6: use bigint, not BigNumber
const MaxUint128 = (2n ** 128n) - 1n
const { MaxUint256 } = ethers

describe('Tick', () => {
  let tickTest: TickTest

  beforeEach('deploy TickTest', async () => {
    // deploy → reattach to get a strongly-typed instance (same pattern as SupplicateMath)
    const f = await ethers.getContractFactory('TickTest')
    const d = await f.deploy()
    tickTest = (await ethers.getContractAt('TickTest', await d.getAddress())) as unknown as TickTest
  })

  describe('#tickSpacingToMaxLiquidityPerTick', () => {
    it('returns the correct value for no fee', async () => {
      const spacing = TICK_SPACINGS[FeeAmount.ZERO]
      const v = await tickTest.tickSpacingToMaxLiquidityPerTick(spacing)
      expect(v.toString()).to.eq('191757530477355301479181766273477')
      expect(v.toString()).to.eq(String(getMaxLiquidityPerTick(spacing)))
    })
    it('returns the correct value for entire range', async () => {
      const v = await tickTest.tickSpacingToMaxLiquidityPerTick(887272)
      expect(v.toString()).to.eq((MaxUint128 / 3n).toString()) // 126 bits
      expect(v.toString()).to.eq(String(getMaxLiquidityPerTick(887272)))
    })
    it('returns the correct value for 2302', async () => {
      const v = await tickTest.tickSpacingToMaxLiquidityPerTick(2302)
      expect(v.toString()).to.eq('441351967472034323558203122479595605') // 118 bits
      expect(v.toString()).to.eq(String(getMaxLiquidityPerTick(2302)))
    })
  })

  describe('#getFeeGrowthInside', () => {
    it('returns all for two uninitialized ticks if tick is inside', async () => {
      const { feeGrowthInside0X128, feeGrowthInside1X128 } = await tickTest.getFeeGrowthInside(-2, 2, 0, 15, 15)
      expect(feeGrowthInside0X128).to.eq(15n)
      expect(feeGrowthInside1X128).to.eq(15n)
    })
    it('returns 0 for two uninitialized ticks if tick is above', async () => {
      const { feeGrowthInside0X128, feeGrowthInside1X128 } = await tickTest.getFeeGrowthInside(-2, 2, 4, 15, 15)
      expect(feeGrowthInside0X128).to.eq(0n)
      expect(feeGrowthInside1X128).to.eq(0n)
    })
    it('returns 0 for two uninitialized ticks if tick is below', async () => {
      const { feeGrowthInside0X128, feeGrowthInside1X128 } = await tickTest.getFeeGrowthInside(-2, 2, -4, 15, 15)
      expect(feeGrowthInside0X128).to.eq(0n)
      expect(feeGrowthInside1X128).to.eq(0n)
    })

    it('subtracts upper tick if below', async () => {
      await tickTest.setTick(2, {
        feeGrowthOutside0X128: 2n,
        feeGrowthOutside1X128: 3n,
        liquidityGross: 0n,
        liquidityNet: 0n,
        secondsPerLiquidityOutsideX128: 0n,
        tickCumulativeOutside: 0n,
        secondsOutside: 0n,
        initialized: true,
      })
      const { feeGrowthInside0X128, feeGrowthInside1X128 } = await tickTest.getFeeGrowthInside(-2, 2, 0, 15, 15)
      expect(feeGrowthInside0X128).to.eq(13n)
      expect(feeGrowthInside1X128).to.eq(12n)
    })

    it('subtracts lower tick if above', async () => {
      await tickTest.setTick(-2, {
        feeGrowthOutside0X128: 2n,
        feeGrowthOutside1X128: 3n,
        liquidityGross: 0n,
        liquidityNet: 0n,
        secondsPerLiquidityOutsideX128: 0n,
        tickCumulativeOutside: 0n,
        secondsOutside: 0n,
        initialized: true,
      })
      const { feeGrowthInside0X128, feeGrowthInside1X128 } = await tickTest.getFeeGrowthInside(-2, 2, 0, 15, 15)
      expect(feeGrowthInside0X128).to.eq(13n)
      expect(feeGrowthInside1X128).to.eq(12n)
    })

    it('subtracts upper and lower tick if inside', async () => {
      await tickTest.setTick(-2, {
        feeGrowthOutside0X128: 2n,
        feeGrowthOutside1X128: 3n,
        liquidityGross: 0n,
        liquidityNet: 0n,
        secondsPerLiquidityOutsideX128: 0n,
        tickCumulativeOutside: 0n,
        secondsOutside: 0n,
        initialized: true,
      })
      await tickTest.setTick(2, {
        feeGrowthOutside0X128: 4n,
        feeGrowthOutside1X128: 1n,
        liquidityGross: 0n,
        liquidityNet: 0n,
        secondsPerLiquidityOutsideX128: 0n,
        tickCumulativeOutside: 0n,
        secondsOutside: 0n,
        initialized: true,
      })
      const { feeGrowthInside0X128, feeGrowthInside1X128 } = await tickTest.getFeeGrowthInside(-2, 2, 0, 15, 15)
      expect(feeGrowthInside0X128).to.eq(9n)
      expect(feeGrowthInside1X128).to.eq(11n)
    })

    it('works correctly with overflow on inside tick', async () => {
      await tickTest.setTick(-2, {
        feeGrowthOutside0X128: (MaxUint256 - 3n),
        feeGrowthOutside1X128: (MaxUint256 - 2n),
        liquidityGross: 0n,
        liquidityNet: 0n,
        secondsPerLiquidityOutsideX128: 0n,
        tickCumulativeOutside: 0n,
        secondsOutside: 0n,
        initialized: true,
      })
      await tickTest.setTick(2, {
        feeGrowthOutside0X128: 3n,
        feeGrowthOutside1X128: 5n,
        liquidityGross: 0n,
        liquidityNet: 0n,
        secondsPerLiquidityOutsideX128: 0n,
        tickCumulativeOutside: 0n,
        secondsOutside: 0n,
        initialized: true,
      })
      const { feeGrowthInside0X128, feeGrowthInside1X128 } = await tickTest.getFeeGrowthInside(-2, 2, 0, 15, 15)
      expect(feeGrowthInside0X128).to.eq(16n)
      expect(feeGrowthInside1X128).to.eq(13n)
    })
  })

  describe('#update', () => {
    it('flips from zero to nonzero', async () => {
      expect(await tickTest.update.staticCall(0, 0, 1, 0, 0, 0, 0, 0, false, 3)).to.eq(true)
    })
    it('does not flip from nonzero to greater nonzero', async () => {
      await tickTest.update(0, 0, 1, 0, 0, 0, 0, 0, false, 3)
      expect(await tickTest.update.staticCall(0, 0, 1, 0, 0, 0, 0, 0, false, 3)).to.eq(false)
    })
    it('flips from nonzero to zero', async () => {
      await tickTest.update(0, 0, 1, 0, 0, 0, 0, 0, false, 3)
      expect(await tickTest.update.staticCall(0, 0, -1, 0, 0, 0, 0, 0, false, 3)).to.eq(true)
    })
    it('does not flip from nonzero to lesser nonzero', async () => {
      await tickTest.update(0, 0, 2, 0, 0, 0, 0, 0, false, 10)
      await tickTest.update(0, 0, 1, 0, 0, 0, 0, 0, true, 10)
      await tickTest.update(0, 0, 3, 0, 0, 0, 0, 0, true, 10)
      await tickTest.update(0, 0, 1, 0, 0, 0, 0, 0, false, 10)
      const { liquidityGross, liquidityNet } = await tickTest.ticks(0)
      expect(liquidityGross).to.eq(2n + 1n + 3n + 1n)
      expect(liquidityNet).to.eq(2n - 1n - 3n + 1n)
    })
    it('reverts on overflow liquidity gross', async () => {
      const halfMinus1 = (MaxUint128 / 2n) - 1n
      await tickTest.update(0, 0, halfMinus1, 0, 0, 0, 0, 0, false, MaxUint128)
      await expect(tickTest.update(0, 0, halfMinus1, 0, 0, 0, 0, 0, false, MaxUint128)).to.be.reverted
    })
    it('assumes all growth happens below ticks lte current tick', async () => {
      await tickTest.update(1, 1, 1, 1, 2, 3, 4, 5, false, MaxUint128)
      const {
        feeGrowthOutside0X128,
        feeGrowthOutside1X128,
        secondsOutside,
        secondsPerLiquidityOutsideX128,
        tickCumulativeOutside,
        initialized,
      } = await tickTest.ticks(1)
      expect(feeGrowthOutside0X128).to.eq(1n)
      expect(feeGrowthOutside1X128).to.eq(2n)
      expect(secondsPerLiquidityOutsideX128).to.eq(3n)
      expect(tickCumulativeOutside).to.eq(4n)
      expect(secondsOutside).to.eq(5n)
      expect(initialized).to.eq(true)
    })
    it('does not set any growth fields if tick is already initialized', async () => {
      await tickTest.update(1, 1, 1, 1, 2, 3, 4, 5, false, MaxUint128)
      await tickTest.update(1, 1, 1, 6, 7, 8, 9, 10, false, MaxUint128)
      const {
        feeGrowthOutside0X128,
        feeGrowthOutside1X128,
        secondsOutside,
        secondsPerLiquidityOutsideX128,
        tickCumulativeOutside,
        initialized,
      } = await tickTest.ticks(1)
      expect(feeGrowthOutside0X128).to.eq(1n)
      expect(feeGrowthOutside1X128).to.eq(2n)
      expect(secondsPerLiquidityOutsideX128).to.eq(3n)
      expect(tickCumulativeOutside).to.eq(4n)
      expect(secondsOutside).to.eq(5n)
      expect(initialized).to.eq(true)
    })
    it('does not set any growth fields for ticks gt current tick', async () => {
      await tickTest.update(2, 1, 1, 1, 2, 3, 4, 5, false, MaxUint128)
      const {
        feeGrowthOutside0X128,
        feeGrowthOutside1X128,
        secondsOutside,
        secondsPerLiquidityOutsideX128,
        tickCumulativeOutside,
        initialized,
      } = await tickTest.ticks(2)
      expect(feeGrowthOutside0X128).to.eq(0n)
      expect(feeGrowthOutside1X128).to.eq(0n)
      expect(secondsPerLiquidityOutsideX128).to.eq(0n)
      expect(tickCumulativeOutside).to.eq(0n)
      expect(secondsOutside).to.eq(0n)
      expect(initialized).to.eq(true)
    })
  })

  // this is skipped because the presence of the method causes slither to fail
  describe('#clear', () => {
    it('deletes all the data in the tick', async () => {
      await tickTest.setTick(2, {
        feeGrowthOutside0X128: 1n,
        feeGrowthOutside1X128: 2n,
        liquidityGross: 3n,
        liquidityNet: 4n,
        secondsPerLiquidityOutsideX128: 5n,
        tickCumulativeOutside: 6n,
        secondsOutside: 7n,
        initialized: true,
      })
      await tickTest.clear(2)
      const {
        feeGrowthOutside0X128,
        feeGrowthOutside1X128,
        secondsOutside,
        secondsPerLiquidityOutsideX128,
        liquidityGross,
        tickCumulativeOutside,
        liquidityNet,
        initialized,
      } = await tickTest.ticks(2)
      expect(feeGrowthOutside0X128).to.eq(0n)
      expect(feeGrowthOutside1X128).to.eq(0n)
      expect(secondsOutside).to.eq(0n)
      expect(secondsPerLiquidityOutsideX128).to.eq(0n)
      expect(tickCumulativeOutside).to.eq(0n)
      expect(liquidityGross).to.eq(0n)
      expect(liquidityNet).to.eq(0n)
      expect(initialized).to.eq(false)
    })
  })

  describe('#cross', () => {
    it('flips the growth variables', async () => {
      await tickTest.setTick(2, {
        feeGrowthOutside0X128: 1n,
        feeGrowthOutside1X128: 2n,
        liquidityGross: 3n,
        liquidityNet: 4n,
        secondsPerLiquidityOutsideX128: 5n,
        tickCumulativeOutside: 6n,
        secondsOutside: 7n,
        initialized: true,
      })
      await tickTest.cross(2, 7n, 9n, 8n, 15n, 10n)
      const {
        feeGrowthOutside0X128,
        feeGrowthOutside1X128,
        secondsOutside,
        tickCumulativeOutside,
        secondsPerLiquidityOutsideX128,
      } = await tickTest.ticks(2)
      expect(feeGrowthOutside0X128).to.eq(6n)
      expect(feeGrowthOutside1X128).to.eq(7n)
      expect(secondsPerLiquidityOutsideX128).to.eq(3n)
      expect(tickCumulativeOutside).to.eq(9n)
      expect(secondsOutside).to.eq(3n)
    })
    it('two flips are no op', async () => {
      await tickTest.setTick(2, {
        feeGrowthOutside0X128: 1n,
        feeGrowthOutside1X128: 2n,
        liquidityGross: 3n,
        liquidityNet: 4n,
        secondsPerLiquidityOutsideX128: 5n,
        tickCumulativeOutside: 6n,
        secondsOutside: 7n,
        initialized: true,
      })
      await tickTest.cross(2, 7n, 9n, 8n, 15n, 10n)
      await tickTest.cross(2, 7n, 9n, 8n, 15n, 10n)
      const {
        feeGrowthOutside0X128,
        feeGrowthOutside1X128,
        secondsOutside,
        tickCumulativeOutside,
        secondsPerLiquidityOutsideX128,
      } = await tickTest.ticks(2)
      expect(feeGrowthOutside0X128).to.eq(1n)
      expect(feeGrowthOutside1X128).to.eq(2n)
      expect(secondsPerLiquidityOutsideX128).to.eq(5n)
      expect(tickCumulativeOutside).to.eq(6n)
      expect(secondsOutside).to.eq(7n)
    })
  })
})