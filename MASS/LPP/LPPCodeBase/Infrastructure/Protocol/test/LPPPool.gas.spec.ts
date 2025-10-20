// test/LPPPool.gas.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'

import type { MockTimeLPPPool } from '../typechain-types/protocol'
import { expect } from './shared/expect.ts'

import { poolFixture } from './shared/fixtures.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'

import {
  expandTo18Decimals,
  FeeAmount,
  getMinTick,
  encodePriceSqrt,
  TICK_SPACINGS,
  createPoolFunctions,
  type SwapFunction,
  type MintFunction,
  getMaxTick,
  MaxUint128,
  type SwapToPriceFunction,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
} from './shared/utilities.ts'

describe('LPPPool gas tests', () => {
  let wallet: HardhatEthersSigner
  let other: HardhatEthersSigner

  before(async () => {
    ;[wallet, other] = (await ethers.getSigners()) as HardhatEthersSigner[]
  })

  for (const feeProtocol of [0, 6]) {
    describe(feeProtocol > 0 ? 'fee is on' : 'fee is off', () => {
      const startingPrice = encodePriceSqrt(100001n, 100000n)
      const startingTick = 0
      const feeAmount = FeeAmount.ZERO
      const tickSpacing = TICK_SPACINGS[feeAmount]
      const minTick = getMinTick(tickSpacing)
      const maxTick = getMaxTick(tickSpacing)

      const gasTestFixture = async () => {
        // reuse the existing fixture helper (originally waffle-style)
        const fix = await (poolFixture as any)([wallet], ethers.provider)

        const pool = (await fix.createPool(feeAmount, tickSpacing)) as MockTimeLPPPool

        const { swapExact0For1, swapToHigherPrice, mint, swapToLowerPrice } = await createPoolFunctions({
          swapTarget: fix.swapTargetCallee,
          token0: fix.token0,
          token1: fix.token1,
          pool,
        })

        await pool.initialize(encodePriceSqrt(1n, 1n))
        await pool.setFeeProtocol(feeProtocol, feeProtocol)
        await pool.increaseObservationCardinalityNext(4)
        await pool.advanceTime(1)
        await mint(await wallet.getAddress(), minTick, maxTick, expandTo18Decimals(2))

        await swapExact0For1(expandTo18Decimals(1), await wallet.getAddress())
        await pool.advanceTime(1)
        await swapToHigherPrice(startingPrice, await wallet.getAddress())
        await pool.advanceTime(1)
        expect((await pool.slot0()).tick).to.eq(startingTick)
        expect((await pool.slot0()).sqrtPriceX96).to.eq(startingPrice)

        return { pool, swapExact0For1, mint, swapToHigherPrice, swapToLowerPrice }
      }

      let swapExact0For1: SwapFunction
      let swapToHigherPrice: SwapToPriceFunction
      let swapToLowerPrice: SwapToPriceFunction
      let pool: MockTimeLPPPool
      let mint: MintFunction

      beforeEach('load the fixture', async () => {
        ;({ swapExact0For1, pool, mint, swapToHigherPrice, swapToLowerPrice } = await loadFixture(gasTestFixture))
      })

      describe('#swapExact0For1', () => {
        it('first swap in block with no tick movement', async () => {
          await snapshotGasCost(swapExact0For1(2000, await wallet.getAddress()))
          expect((await pool.slot0()).sqrtPriceX96).to.not.eq(startingPrice)
          expect((await pool.slot0()).tick).to.eq(startingTick)
        })

        it('first swap in block moves tick, no initialized crossings', async () => {
          await snapshotGasCost(swapExact0For1(expandTo18Decimals(1) / 10000n, await wallet.getAddress()))
          expect((await pool.slot0()).tick).to.eq(startingTick - 1)
        })

        it('second swap in block with no tick movement', async () => {
          await swapExact0For1(expandTo18Decimals(1) / 10000n, await wallet.getAddress())
          expect((await pool.slot0()).tick).to.eq(startingTick - 1)
          await snapshotGasCost(swapExact0For1(2000, await wallet.getAddress()))
          expect((await pool.slot0()).tick).to.eq(startingTick - 1)
        })

        it('second swap in block moves tick, no initialized crossings', async () => {
          await swapExact0For1(1000, await wallet.getAddress())
          expect((await pool.slot0()).tick).to.eq(startingTick)
          await snapshotGasCost(swapExact0For1(expandTo18Decimals(1) / 10000n, await wallet.getAddress()))
          expect((await pool.slot0()).tick).to.eq(startingTick - 1)
        })

        it('first swap in block, large swap, no initialized crossings', async () => {
          await snapshotGasCost(swapExact0For1(expandTo18Decimals(10), await wallet.getAddress()))
          expect((await pool.slot0()).tick).to.eq(-35837)
        })

        it('first swap in block, large swap crossing several initialized ticks', async () => {
          await mint(await wallet.getAddress(), startingTick - 3 * tickSpacing, startingTick - tickSpacing, expandTo18Decimals(1))
          await mint(
            await wallet.getAddress(),
            startingTick - 4 * tickSpacing,
            startingTick - 2 * tickSpacing,
            expandTo18Decimals(1)
          )
          expect((await pool.slot0()).tick).to.eq(startingTick)
          await snapshotGasCost(swapExact0For1(expandTo18Decimals(1), await wallet.getAddress()))
          expect((await pool.slot0()).tick).to.be.lt(startingTick - 4 * tickSpacing) // crossed last tick
        })

        it('first swap in block, large swap crossing a single initialized tick', async () => {
          await mint(await wallet.getAddress(), minTick, startingTick - 2 * tickSpacing, expandTo18Decimals(1))
          await snapshotGasCost(swapExact0For1(expandTo18Decimals(1), await wallet.getAddress()))
          expect((await pool.slot0()).tick).to.be.lt(startingTick - 2 * tickSpacing)
        })

        it('second swap in block, large swap crossing several initialized ticks', async () => {
          await mint(await wallet.getAddress(), startingTick - 3 * tickSpacing, startingTick - tickSpacing, expandTo18Decimals(1))
          await mint(
            await wallet.getAddress(),
            startingTick - 4 * tickSpacing,
            startingTick - 2 * tickSpacing,
            expandTo18Decimals(1)
          )
          await swapExact0For1(expandTo18Decimals(1) / 10000n, await wallet.getAddress())
          await snapshotGasCost(swapExact0For1(expandTo18Decimals(1), await wallet.getAddress()))
          expect((await pool.slot0()).tick).to.be.lt(startingTick - 4 * tickSpacing)
        })

        it('second swap in block, large swap crossing a single initialized tick', async () => {
          await mint(await wallet.getAddress(), minTick, startingTick - 2 * tickSpacing, expandTo18Decimals(1))
          await swapExact0For1(expandTo18Decimals(1) / 10000n, await wallet.getAddress())
          expect((await pool.slot0()).tick).to.be.gt(startingTick - 2 * tickSpacing) // no cross yet
          await snapshotGasCost(swapExact0For1(expandTo18Decimals(1), await wallet.getAddress()))
          expect((await pool.slot0()).tick).to.be.lt(startingTick - 2 * tickSpacing)
        })

        it('large swap crossing several initialized ticks after some time passes', async () => {
          await mint(await wallet.getAddress(), startingTick - 3 * tickSpacing, startingTick - tickSpacing, expandTo18Decimals(1))
          await mint(
            await wallet.getAddress(),
            startingTick - 4 * tickSpacing,
            startingTick - 2 * tickSpacing,
            expandTo18Decimals(1)
          )
          await swapExact0For1(2, await wallet.getAddress())
          await pool.advanceTime(1)
          await snapshotGasCost(swapExact0For1(expandTo18Decimals(1), await wallet.getAddress()))
          expect((await pool.slot0()).tick).to.be.lt(startingTick - 4 * tickSpacing)
        })

        it('large swap crossing several initialized ticks second time after some time passes', async () => {
          await mint(await wallet.getAddress(), startingTick - 3 * tickSpacing, startingTick - tickSpacing, expandTo18Decimals(1))
          await mint(
            await wallet.getAddress(),
            startingTick - 4 * tickSpacing,
            startingTick - 2 * tickSpacing,
            expandTo18Decimals(1)
          )
          await swapExact0For1(expandTo18Decimals(1), await wallet.getAddress())
          await swapToHigherPrice(startingPrice, await wallet.getAddress())
          await pool.advanceTime(1)
          await snapshotGasCost(swapExact0For1(expandTo18Decimals(1), await wallet.getAddress()))
          expect((await pool.slot0()).tick).to.be.lt(tickSpacing * -4)
        })
      })

      describe('#mint', () => {
        for (const { description, tickLower, tickUpper } of [
          { description: 'around current price', tickLower: startingTick - tickSpacing, tickUpper: startingTick + tickSpacing },
          { description: 'below current price', tickLower: startingTick - 2 * tickSpacing, tickUpper: startingTick - tickSpacing },
          { description: 'above current price', tickLower: startingTick + tickSpacing, tickUpper: startingTick + 2 * tickSpacing },
        ]) {
          describe(description, () => {
            it('new position mint first in range', async () => {
              await snapshotGasCost(mint(await wallet.getAddress(), tickLower, tickUpper, expandTo18Decimals(1)))
            })
            it('add to position existing', async () => {
              await mint(await wallet.getAddress(), tickLower, tickUpper, expandTo18Decimals(1))
              await snapshotGasCost(mint(await wallet.getAddress(), tickLower, tickUpper, expandTo18Decimals(1)))
            })
            it('second position in same range', async () => {
              await mint(await wallet.getAddress(), tickLower, tickUpper, expandTo18Decimals(1))
              await snapshotGasCost(mint(await other.getAddress(), tickLower, tickUpper, expandTo18Decimals(1)))
            })
            it('add to position after some time passes', async () => {
              await mint(await wallet.getAddress(), tickLower, tickUpper, expandTo18Decimals(1))
              await pool.advanceTime(1)
              await snapshotGasCost(mint(await wallet.getAddress(), tickLower, tickUpper, expandTo18Decimals(1)))
            })
          })
        }
      })

      describe('#burn', () => {
        for (const { description, tickLower, tickUpper } of [
          { description: 'around current price', tickLower: startingTick - tickSpacing, tickUpper: startingTick + tickSpacing },
          { description: 'below current price', tickLower: startingTick - 2 * tickSpacing, tickUpper: startingTick - tickSpacing },
          { description: 'above current price', tickLower: startingTick + tickSpacing, tickUpper: startingTick + 2 * tickSpacing },
        ]) {
          describe(description, () => {
            const liquidityAmount = expandTo18Decimals(1)
            beforeEach('mint a position', async () => {
              await mint(await wallet.getAddress(), tickLower, tickUpper, liquidityAmount)
            })

            it('burn when only position using ticks', async () => {
              await snapshotGasCost(pool.burn(tickLower, tickUpper, expandTo18Decimals(1)))
            })
            it('partial position burn', async () => {
              await snapshotGasCost(pool.burn(tickLower, tickUpper, expandTo18Decimals(1) / 2n))
            })
            it('entire position burn but other positions are using the ticks', async () => {
              await mint(await other.getAddress(), tickLower, tickUpper, expandTo18Decimals(1))
              await snapshotGasCost(pool.burn(tickLower, tickUpper, expandTo18Decimals(1)))
            })
            it('burn entire position after some time passes', async () => {
              await pool.advanceTime(1)
              await snapshotGasCost(pool.burn(tickLower, tickUpper, expandTo18Decimals(1)))
            })
          })
        }
      })

      describe('#poke', () => {
        const tickLower = startingTick - tickSpacing
        const tickUpper = startingTick + tickSpacing

        it('best case', async () => {
          await mint(await wallet.getAddress(), tickLower, tickUpper, expandTo18Decimals(1))
          await swapExact0For1(expandTo18Decimals(1) / 100n, await wallet.getAddress())
          await pool.burn(tickLower, tickUpper, 0)
          await swapExact0For1(expandTo18Decimals(1) / 100n, await wallet.getAddress())
          await snapshotGasCost(pool.burn(tickLower, tickUpper, 0))
        })
      })

      describe('#collect', () => {
        const tickLower = startingTick - tickSpacing
        const tickUpper = startingTick + tickSpacing

        it('close to worst case', async () => {
          await mint(await wallet.getAddress(), tickLower, tickUpper, expandTo18Decimals(1))
          await swapExact0For1(expandTo18Decimals(1) / 100n, await wallet.getAddress())
          await pool.burn(tickLower, tickUpper, 0) // poke to accumulate fees
          await snapshotGasCost(pool.collect(await wallet.getAddress(), tickLower, tickUpper, MaxUint128, MaxUint128))
        })
      })

      describe('#increaseObservationCardinalityNext', () => {
        it('grow by 1 slot', async () => {
          await snapshotGasCost(pool.increaseObservationCardinalityNext(5))
        })
        it('no op', async () => {
          await snapshotGasCost(pool.increaseObservationCardinalityNext(3))
        })
      })

      describe('#snapshotCumulativesInside', () => {
        it('tick inside', async () => {
          await snapshotGasCost(
            pool.getFunction('snapshotCumulativesInside').estimateGas(minTick, maxTick)
          )
        })
        it('tick above', async () => {
          await swapToHigherPrice(MAX_SQRT_RATIO - 1n, await wallet.getAddress())
          await snapshotGasCost(
            pool.getFunction('snapshotCumulativesInside').estimateGas(minTick, maxTick)
          )
        })
        it('tick below', async () => {
          await swapToLowerPrice(MIN_SQRT_RATIO + 1n, await wallet.getAddress())
          await snapshotGasCost(
            pool.getFunction('snapshotCumulativesInside').estimateGas(minTick, maxTick)
          )
        })
      })
    })
  }
})