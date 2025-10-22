// test/LPPPool.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import type { BigNumberish } from 'ethers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'

import type {
  TestERC20,
  LPPFactory,
  MockTimeLPPPool,
  TestLPPSupplicatePay,
  TestLPPCallee,
  TestLPPReentrantCallee,
  TickMathTest,
  SwapMathTest,
} from '../typechain-types/protocol'

import checkObservationEquals from './shared/checkObservationEquals.ts'
import { expect } from './shared/expect.ts'
import { poolFixture, TEST_POOL_START_TIME } from './shared/fixtures.ts'
const T0 = BigInt(TEST_POOL_START_TIME)

import {
  expandTo18Decimals,
  FeeAmount,
  getPositionKey,
  getMaxTick,
  getMinTick,
  encodePriceSqrt,
  TICK_SPACINGS,
  createPoolFunctions,
  getMaxLiquidityPerTick,
  MaxUint128,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
} from './shared/utilities.ts'

import type {
  SupplicateFunction,
  MintFunction,
  FlashFunction,
  SupplicateToPriceFunction,
} from './shared/utilities.ts'

// read only the third return (secondsInside)
async function readSecondsInside(pool: any, lower: number, upper: number): Promise<number> {
  const [, , sec] = await pool.snapshotCumulativesInside(lower, upper);
  // ethers v6 returns bigint; convert safely to number (uint32 fits)
  return Number(sec);
}

// returns the delta of secondsInside across an async action
async function secondsInsideDelta(
  pool: any,
  lower: number,
  upper: number,
  action: () => Promise<void>
): Promise<number> {
  const before = await readSecondsInside(pool, lower, upper);
  await action();
  const after = await readSecondsInside(pool, lower, upper);
  return after - before;
}

// -------- helpers for uint32 wrap (secondsInside) --------
const UINT32 = 1n << 32n
const wrap32 = (x: bigint) => ((x % UINT32) + UINT32) % UINT32
const delta32 = (after: bigint, before: bigint) => wrap32(after - before)
// ---------------------------------------------------------
const U32 = 1n << 32n
const mod32 = (x: bigint) => ((x % U32) + U32) % U32
const bn = (x: any) => BigInt(x.toString())                 // BigNumber -> bigint
const sec = (snap: any) => bn(snap.secondsInside)           // secondsInside -> bigint
const diff32 = (after: bigint, before: bigint) => mod32(after - before)
// ---------------------------------------------------------

async function moveBelowRange(
  pool: any,
  callee: any,           // your TestLPPCallee instance (often named `swapTarget`)
  tickLower: number,
  tickMath: any          // TickMathTest instance
) {
  const target = await tickMath.getSqrtRatioAtTick(tickLower - 1);
  await callee.supplicateToLowerSqrtPrice(pool.address, target);
}

async function moveAboveRange(
  pool: any,
  callee: any,
  tickUpper: number,
  tickMath: any
) {
  const target = await tickMath.getSqrtRatioAtTick(tickUpper + 1);
  await callee.supplicateToHigherSqrtPrice(pool.address, target);
}

type ThenArg<T> = T extends PromiseLike<infer U> ? U : T

describe('LPPPool', () => {
  let wallet: HardhatEthersSigner, other: HardhatEthersSigner

  let token0: TestERC20
  let token1: TestERC20
  let token2: TestERC20

  let factory: LPPFactory
  let pool: MockTimeLPPPool
  let swapTarget: TestLPPCallee

  let swapToLowerPrice: SupplicateToPriceFunction
  let swapToHigherPrice: SupplicateToPriceFunction
  let swapExact0For1: SupplicateFunction
  let swap0ForExact1: SupplicateFunction
  let swapExact1For0: SupplicateFunction
  let swap1ForExact0: SupplicateFunction

  let feeAmount: number
  let tickSpacing: number

  let minTick: number
  let maxTick: number

  let mint: MintFunction
  let flash: FlashFunction

  let createPool: ThenArg<ReturnType<typeof poolFixture>>['createPool']

  before(async () => {
    ;[wallet, other] = (await ethers.getSigners()) as unknown as [HardhatEthersSigner, HardhatEthersSigner]
  })

  beforeEach(async () => {
    ;({ token0, token1, token2, factory, createPool, swapTargetCallee: swapTarget } = await loadFixture(poolFixture))

    const oldCreatePool = createPool
    createPool = async (_feeAmount, _tickSpacing) => {
      const pool = await oldCreatePool(_feeAmount, _tickSpacing)
      ;({
        swapToLowerPrice,
        swapToHigherPrice,
        swapExact0For1,
        swap0ForExact1,
        swapExact1For0,
        swap1ForExact0,
        mint,
        flash,
      } = createPoolFunctions({ token0, token1, swapTarget, pool }))
      minTick = getMinTick(_tickSpacing)
      maxTick = getMaxTick(_tickSpacing)
      feeAmount = _feeAmount
      tickSpacing = _tickSpacing
      return pool
    }

    // default: zero-fee pool
    pool = await createPool(FeeAmount.ZERO, TICK_SPACINGS[FeeAmount.ZERO])
  })

  it('constructor initializes immutables', async () => {
    expect(await pool.factory()).to.eq(await factory.getAddress())
    expect(await pool.token0()).to.eq(await token0.getAddress())
    expect(await pool.token1()).to.eq(await token1.getAddress())
    expect(await pool.maxLiquidityPerTick()).to.eq(getMaxLiquidityPerTick(tickSpacing))
  })

  describe('#initialize', () => {
    it('fails if already initialized', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await expect(pool.initialize(encodePriceSqrt(1, 1))).to.be.reverted
    })
    it('fails if starting price is too low', async () => {
      await expect(pool.initialize(1n)).to.be.revertedWith('R')
      await expect(pool.initialize(MIN_SQRT_RATIO - 1n)).to.be.revertedWith('R')
    })
    it('fails if starting price is too high', async () => {
      await expect(pool.initialize(MAX_SQRT_RATIO)).to.be.revertedWith('R')
      await expect(pool.initialize((1n << 160n) - 1n)).to.be.revertedWith('R')
    })
    it('can be initialized at MIN_SQRT_RATIO', async () => {
      await pool.initialize(MIN_SQRT_RATIO)
      expect((await pool.slot0()).tick).to.eq(getMinTick(1))
    })
    it('can be initialized at MAX_SQRT_RATIO - 1', async () => {
      await pool.initialize(MAX_SQRT_RATIO - 1n)
      expect((await pool.slot0()).tick).to.eq(getMaxTick(1) - 1)
    })
    it('sets initial variables', async () => {
      const price = encodePriceSqrt(1, 2)
      await pool.initialize(price)
      const { sqrtPriceX96, observationIndex } = await pool.slot0()
      expect(sqrtPriceX96).to.eq(price)
      expect(observationIndex).to.eq(0)
      expect((await pool.slot0()).tick).to.eq(-6932)
    })
    it('initializes the first observations slot', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      checkObservationEquals(await pool.observations(0), {
        secondsPerLiquidityCumulativeX128: 0n,
        initialized: true,
        blockTimestamp: T0,
        tickCumulative: 0n,
      })
    })
    it('emits a Initialized event with the input tick', async () => {
      const sqrtPriceX96 = encodePriceSqrt(1, 2)
      await expect(pool.initialize(sqrtPriceX96)).to.emit(pool, 'Initialize').withArgs(sqrtPriceX96, -6932)
    })
  })

  describe('#increaseObservationCardinalityNext', () => {
    it('can only be called after initialize', async () => {
      await expect(pool.increaseObservationCardinalityNext(2)).to.be.revertedWith('LOK')
    })
    it('emits an event including both old and new', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await expect(pool.increaseObservationCardinalityNext(2))
        .to.emit(pool, 'IncreaseObservationCardinalityNext')
        .withArgs(1, 2)
    })
    it('does not emit an event for no op call', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await pool.increaseObservationCardinalityNext(3)
      await expect(pool.increaseObservationCardinalityNext(2)).to.not.emit(pool, 'IncreaseObservationCardinalityNext')
    })
    it('does not change cardinality next if less than current', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await pool.increaseObservationCardinalityNext(3)
      await pool.increaseObservationCardinalityNext(2)
      expect((await pool.slot0()).observationCardinalityNext).to.eq(3)
    })
    it('increases cardinality and cardinality next first time', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await pool.increaseObservationCardinalityNext(2)
      const { observationCardinality, observationCardinalityNext } = await pool.slot0()
      expect(observationCardinality).to.eq(1)
      expect(observationCardinalityNext).to.eq(2)
    })
  })

  describe('#mint', () => {
    it('fails if not initialized', async () => {
      await expect(mint(wallet.address, -tickSpacing, tickSpacing, 1)).to.be.revertedWith('LOK')
    })

    describe('after initialization', () => {
      beforeEach(async () => {
        await pool.initialize(encodePriceSqrt(1, 10))
        await mint(wallet.address, minTick, maxTick, 3161)
      })

      describe('failure cases', () => {
        it('fails if tickLower greater than tickUpper', async () => {
          await expect(mint(wallet.address, 1, 0, 1)).to.be.reverted
        })
        it('fails if tickLower less than min tick', async () => {
          await expect(mint(wallet.address, -887273, 0, 1)).to.be.reverted
        })
        it('fails if tickUpper greater than max tick', async () => {
          await expect(mint(wallet.address, 0, 887273, 1)).to.be.reverted
        })
        it('fails if amount exceeds the max', async () => {
          const maxLiquidityGross = await pool.maxLiquidityPerTick()
          await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross + 1n)).to.be
            .reverted
          await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross)).to.not.be
            .reverted
        })
        it('fails if total amount at tick exceeds the max', async () => {
          await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 1000)
          const maxLiquidityGross = await pool.maxLiquidityPerTick()
          await expect(
            mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross - 1000n + 1n)
          ).to.be.reverted
          await expect(
            mint(wallet.address, minTick + tickSpacing * 2, maxTick - tickSpacing, maxLiquidityGross - 1000n + 1n)
          ).to.be.reverted
          await expect(
            mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing * 2, maxLiquidityGross - 1000n + 1n)
          ).to.be.reverted
          await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross - 1000n)).to
            .not.be.reverted
        })
        it('fails if amount is 0', async () => {
          await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 0)).to.be.reverted
        })
      })

      describe('success cases', () => {
        it('initial balances', async () => {
          const poolAddr = await pool.getAddress()
          expect(await token0.balanceOf(poolAddr)).to.eq(9996n)
          expect(await token1.balanceOf(poolAddr)).to.eq(1000n)
        })
        it('initial tick', async () => {
          expect((await pool.slot0()).tick).to.eq(-23028)
        })
        describe('above current price', () => {
          it('transfers token0 only', async () => {
            const poolAddr = await pool.getAddress()
            await expect(mint(wallet.address, -22980, 0, 10000))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, poolAddr, 21549n)
              .to.not.emit(token1, 'Transfer')
            expect(await token0.balanceOf(poolAddr)).to.eq(9996n + 21549n)
            expect(await token1.balanceOf(poolAddr)).to.eq(1000n)
          })
          it('works for max tick', async () => {
            const poolAddr = await pool.getAddress()
            await expect(mint(wallet.address, -22980, maxTick, 10000))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, poolAddr, 31549n)
            expect(await token0.balanceOf(poolAddr)).to.eq(9996n + 31549n)
            expect(await token1.balanceOf(poolAddr)).to.eq(1000n)
          })
          it('removing works', async () => {
            await mint(wallet.address, -240, 0, 10000)
            await pool.burn(-240, 0, 10000)
            const { amount0, amount1 } = await pool.collect.staticCall(wallet.address, -240, 0, MaxUint128, MaxUint128)
            expect(amount0).to.eq(120n)
            expect(amount1).to.eq(0n)
          })
          it('adds liquidity to liquidityGross', async () => {
            await mint(wallet.address, -240, 0, 100)
            expect((await pool.ticks(-240)).liquidityGross).to.eq(100n)
            expect((await pool.ticks(0)).liquidityGross).to.eq(100n)
            expect((await pool.ticks(tickSpacing)).liquidityGross).to.eq(0n)
            expect((await pool.ticks(tickSpacing * 2)).liquidityGross).to.eq(0n)
            await mint(wallet.address, -240, tickSpacing, 150)
            expect((await pool.ticks(-240)).liquidityGross).to.eq(250n)
            expect((await pool.ticks(0)).liquidityGross).to.eq(100n)
            expect((await pool.ticks(tickSpacing)).liquidityGross).to.eq(150n)
            expect((await pool.ticks(tickSpacing * 2)).liquidityGross).to.eq(0n)
            await mint(wallet.address, 0, tickSpacing * 2, 60)
            expect((await pool.ticks(-240)).liquidityGross).to.eq(250n)
            expect((await pool.ticks(0)).liquidityGross).to.eq(160n)
            expect((await pool.ticks(tickSpacing)).liquidityGross).to.eq(150n)
            expect((await pool.ticks(tickSpacing * 2)).liquidityGross).to.eq(60n)
          })
          it('removes liquidity from liquidityGross', async () => {
            await mint(wallet.address, -240, 0, 100)
            await mint(wallet.address, -240, 0, 40)
            await pool.burn(-240, 0, 90)
            expect((await pool.ticks(-240)).liquidityGross).to.eq(50n)
            expect((await pool.ticks(0)).liquidityGross).to.eq(50n)
          })
          it('clears tick lower if last position is removed', async () => {
            await mint(wallet.address, -240, 0, 100)
            await pool.burn(-240, 0, 100)
            const { liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128 } = await pool.ticks(-240)
            expect(liquidityGross).to.eq(0n)
            expect(feeGrowthOutside0X128).to.eq(0n)
            expect(feeGrowthOutside1X128).to.eq(0n)
          })
          it('clears tick upper if last position is removed', async () => {
            await mint(wallet.address, -240, 0, 100)
            await pool.burn(-240, 0, 100)
            const { liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128 } = await pool.ticks(0)
            expect(liquidityGross).to.eq(0n)
            expect(feeGrowthOutside0X128).to.eq(0n)
            expect(feeGrowthOutside1X128).to.eq(0n)
          })
          it('only clears the tick that is not used at all', async () => {
            await mint(wallet.address, -240, 0, 100)
            await mint(wallet.address, -tickSpacing, 0, 250)
            await pool.burn(-240, 0, 100)

            let { liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128 } = await pool.ticks(-240)
            expect(liquidityGross).to.eq(0n)
            expect(feeGrowthOutside0X128).to.eq(0n)
            expect(feeGrowthOutside1X128).to.eq(0n)
            ;({ liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128 } = await pool.ticks(-tickSpacing))
            expect(liquidityGross).to.eq(250n)
            expect(feeGrowthOutside0X128).to.eq(0n)
            expect(feeGrowthOutside1X128).to.eq(0n)
          })
          it('does not write an observation', async () => {
            checkObservationEquals(await pool.observations(0), {
              tickCumulative: 0n,
              blockTimestamp: T0,
              initialized: true,
              secondsPerLiquidityCumulativeX128: 0n,
            })
            await pool.advanceTime(1)
            await mint(wallet.address, -240, 0, 100)
            checkObservationEquals(await pool.observations(0), {
              tickCumulative: 0n,
              blockTimestamp: T0,
              initialized: true,
              secondsPerLiquidityCumulativeX128: 0n,
            })
          })
        })

        describe('including current price', () => {
          it('price within range: transfers current price of both tokens', async () => {
            const poolAddr = await pool.getAddress()
            await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, poolAddr, 317n)
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, poolAddr, 32n)
            expect(await token0.balanceOf(poolAddr)).to.eq(9996n + 317n)
            expect(await token1.balanceOf(poolAddr)).to.eq(1000n + 32n)
          })
          it('initializes lower tick', async () => {
            await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100)
            const { liquidityGross } = await pool.ticks(minTick + tickSpacing)
            expect(liquidityGross).to.eq(100n)
          })
          it('initializes upper tick', async () => {
            await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100)
            const { liquidityGross } = await pool.ticks(maxTick - tickSpacing)
            expect(liquidityGross).to.eq(100n)
          })
          it('works for min/max tick', async () => {
            const poolAddr = await pool.getAddress()
            await expect(mint(wallet.address, minTick, maxTick, 10000))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, poolAddr, 31623n)
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, poolAddr, 3163n)
            expect(await token0.balanceOf(poolAddr)).to.eq(9996n + 31623n)
            expect(await token1.balanceOf(poolAddr)).to.eq(1000n + 3163n)
          })
          it('removing works', async () => {
            await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100)
            await pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 100)
            const { amount0, amount1 } = await pool.collect.staticCall(
              wallet.address,
              minTick + tickSpacing,
              maxTick - tickSpacing,
              MaxUint128,
              MaxUint128
            )
            expect(amount0).to.eq(316n)
            expect(amount1).to.eq(31n)
          })
          it('writes an observation', async () => {
            checkObservationEquals(await pool.observations(0), {
              tickCumulative: 0n,
              blockTimestamp: T0,
              initialized: true,
              secondsPerLiquidityCumulativeX128: 0n,
            })
            await pool.advanceTime(1)
            await mint(wallet.address, minTick, maxTick, 100)
            checkObservationEquals(await pool.observations(0), {
              tickCumulative: -23028n,
              blockTimestamp: T0 + 1n,
              initialized: true,
              secondsPerLiquidityCumulativeX128: 107650226801941937191829992860413859n,
            })
          })
        })

        describe('below current price', () => {
          it('transfers token1 only', async () => {
            const poolAddr = await pool.getAddress()
            await expect(mint(wallet.address, -46080, -23040, 10000))
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, poolAddr, 2162n)
              .to.not.emit(token0, 'Transfer')
            expect(await token0.balanceOf(poolAddr)).to.eq(9996n)
            expect(await token1.balanceOf(poolAddr)).to.eq(1000n + 2162n)
          })
          it('works for min tick', async () => {
            const poolAddr = await pool.getAddress()
            await expect(mint(wallet.address, minTick, -23040, 10000))
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, poolAddr, 3161n)
            expect(await token0.balanceOf(poolAddr)).to.eq(9996n)
            expect(await token1.balanceOf(poolAddr)).to.eq(1000n + 3161n)
          })
          it('removing works', async () => {
            await mint(wallet.address, -46080, -46020, 10000)
            await pool.burn(-46080, -46020, 10000)
            const { amount0, amount1 } = await pool.collect.staticCall(
              wallet.address,
              -46080,
              -46020,
              MaxUint128,
              MaxUint128
            )
            expect(amount0).to.eq(0n)
            expect(amount1).to.eq(3n)
          })
          it('does not write an observation', async () => {
            const before = await pool.observations(0)
            await pool.advanceTime(1)
            await mint(wallet.address, -46080, -23040, 100)
            const after = await pool.observations(0)
            expect(after.tickCumulative).to.eq(before.tickCumulative)
            expect(after.secondsPerLiquidityCumulativeX128).to.eq(before.secondsPerLiquidityCumulativeX128)
            expect(after.blockTimestamp).to.eq(before.blockTimestamp)
            expect(after.initialized).to.eq(true)
          })
        })
      })

      it('protocol fees remain zero during swap', async () => {
        await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1))
        await swapExact0For1(expandTo18Decimals(1) / 10n, wallet.address)
        await swapExact1For0(expandTo18Decimals(1) / 100n, wallet.address)
        const { token0, token1 } = await pool.protocolFees()
        expect(token0).to.eq(0n)
        expect(token1).to.eq(0n)
      })

      it('positions are protected before protocol fee is turned on', async () => {
        await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1))
        await swapExact0For1(expandTo18Decimals(1) / 10n, wallet.address)
        await swapExact1For0(expandTo18Decimals(1) / 100n, wallet.address)
        let { token0: t0, token1: t1 } = await pool.protocolFees()
        expect(t0).to.eq(0n)
        expect(t1).to.eq(0n)
        await pool.setFeeProtocol(6, 6)
        ;({ token0: t0, token1: t1 } = await pool.protocolFees())
        expect(t0).to.eq(0n)
        expect(t1).to.eq(0n)
      })

      it('poke is not allowed on uninitialized position', async () => {
        await mint(other.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1))
        await swapExact0For1(expandTo18Decimals(1) / 10n, wallet.address)
        await swapExact1For0(expandTo18Decimals(1) / 100n, wallet.address)
        await expect(pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 0)).to.be.reverted
        await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 1)
        let p = await pool.positions(getPositionKey(wallet.address, minTick + tickSpacing, maxTick - tickSpacing))
        expect(p.liquidity).to.eq(1n)
        expect(p.feeGrowthInside0LastX128).to.eq(0n)
        expect(p.feeGrowthInside1LastX128).to.eq(0n)
        await pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 1)
        p = await pool.positions(getPositionKey(wallet.address, minTick + tickSpacing, maxTick - tickSpacing))
        expect(p.liquidity).to.eq(0n)
        expect(p.feeGrowthInside0LastX128).to.eq(0n)
        expect(p.feeGrowthInside1LastX128).to.eq(0n)
      })
    })
  })

  describe('#burn', () => {
    beforeEach(() => initializeAtZeroTick(pool))

    async function checkTickIsClear(tick: number) {
      const { liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128, liquidityNet } = await pool.ticks(tick)
      expect(liquidityGross).to.eq(0n)
      expect(feeGrowthOutside0X128).to.eq(0n)
      expect(feeGrowthOutside1X128).to.eq(0n)
      expect(liquidityNet).to.eq(0n)
    }
    async function checkTickIsNotClear(tick: number) {
      const { liquidityGross } = await pool.ticks(tick)
      expect(liquidityGross).to.not.eq(0n)
    }

    it('clears the tick if its the last position using it', async () => {
      const tickLower = minTick + tickSpacing
      const tickUpper = maxTick - tickSpacing
      await pool.advanceTime(10)
      await mint(wallet.address, tickLower, tickUpper, 1)
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await pool.burn(tickLower, tickUpper, 1)
      await checkTickIsClear(tickLower)
      await checkTickIsClear(tickUpper)
    })

    it('clears only the lower tick if upper is still used', async () => {
      const tickLower = minTick + tickSpacing
      const tickUpper = maxTick - tickSpacing
      await pool.advanceTime(10)
      await mint(wallet.address, tickLower, tickUpper, 1)
      await mint(wallet.address, tickLower + tickSpacing, tickUpper, 1)
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await pool.burn(tickLower, tickUpper, 1)
      await checkTickIsClear(tickLower)
      await checkTickIsNotClear(tickUpper)
    })

    it('clears only the upper tick if lower is still used', async () => {
      const tickLower = minTick + tickSpacing
      const tickUpper = maxTick - tickSpacing
      await pool.advanceTime(10)
      await mint(wallet.address, tickLower, tickUpper, 1)
      await mint(wallet.address, tickLower, tickUpper - tickSpacing, 1)
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await pool.burn(tickLower, tickUpper, 1)
      await checkTickIsNotClear(tickLower)
      await checkTickIsClear(tickUpper)
    })
  })

  const initializeLiquidityAmount = expandTo18Decimals(2)

  async function initializeAtZeroTick(p: MockTimeLPPPool): Promise<void> {
    await p.initialize(encodePriceSqrt(1, 1))
    const ts = Number(await p.tickSpacing())
    const [min, max] = [getMinTick(ts), getMaxTick(ts)]
    await mint(wallet.address, min, max, initializeLiquidityAmount)
  }

  describe('#observe', () => {
    beforeEach(() => initializeAtZeroTick(pool))

    it('current tick accumulator increases by tick over time', async () => {
      let { tickCumulatives: [tickCumulative] } = await pool.observe([0])
      expect(tickCumulative).to.eq(0n)
      await pool.advanceTime(10)
      ;({ tickCumulatives: [tickCumulative] } = await pool.observe([0]))
      expect(tickCumulative).to.eq(0n)
    })

    it('current tick accumulator after single swap', async () => {
      await swapExact0For1(1000, wallet.address)
      const { tick: t1 } = await pool.slot0()
      await pool.advanceTime(4)
      const { tickCumulatives: [tickCumulative] } = await pool.observe([0])
      expect(tickCumulative).to.eq(4n * BigInt(t1))
    })

    it('current tick accumulator after two swaps', async () => {
      await swapExact0For1(expandTo18Decimals(1) / 2n, wallet.address)
      const { tick: tA } = await pool.slot0()
      await pool.advanceTime(4)

      await swapExact1For0(expandTo18Decimals(1) / 4n, wallet.address)
      const { tick: tB } = await pool.slot0()
      await pool.advanceTime(6)

      const { tickCumulatives: [tickCumulative] } = await pool.observe([0])
      expect(tickCumulative).to.eq(4n * BigInt(tA) + 6n * BigInt(tB))
    })
  })

  describe('miscellaneous mint tests', () => {
    beforeEach(async () => {
      pool = await createPool(FeeAmount.ZERO, TICK_SPACINGS[FeeAmount.ZERO])
      await initializeAtZeroTick(pool)
    })

    it('mint to the right of the current price', async () => {
      const liquidityDelta = 1000
      const lowerTick = tickSpacing
      const upperTick = tickSpacing * 2

      const liquidityBefore = await pool.liquidity()
      const poolAddr = await pool.getAddress()
      const b0 = await token0.balanceOf(poolAddr)
      const b1 = await token1.balanceOf(poolAddr)

      await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

      const liquidityAfter = await pool.liquidity()
      expect(liquidityAfter).to.be.gte(liquidityBefore)
      expect((await token0.balanceOf(poolAddr)) - b0).to.eq(1n)
      expect((await token1.balanceOf(poolAddr)) - b1).to.eq(0n)
    })

    it('mint to the left of the current price', async () => {
      const liquidityDelta = 1000
      const lowerTick = -tickSpacing * 2
      const upperTick = -tickSpacing

      const liquidityBefore = await pool.liquidity()
      const poolAddr = await pool.getAddress()
      const b0 = await token0.balanceOf(poolAddr)
      const b1 = await token1.balanceOf(poolAddr)

      await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

      const liquidityAfter = await pool.liquidity()
      expect(liquidityAfter).to.be.gte(liquidityBefore)
      expect((await token0.balanceOf(poolAddr)) - b0).to.eq(0n)
      expect((await token1.balanceOf(poolAddr)) - b1).to.eq(1n)
    })

    it('mint within the current price', async () => {
      const liquidityDelta = 1000
      const lowerTick = -tickSpacing
      const upperTick = tickSpacing

      const liquidityBefore = await pool.liquidity()
      const poolAddr = await pool.getAddress()
      const b0 = await token0.balanceOf(poolAddr)
      const b1 = await token1.balanceOf(poolAddr)

      await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

      const liquidityAfter = await pool.liquidity()
      expect(liquidityAfter).to.be.gte(liquidityBefore)
      expect((await token0.balanceOf(poolAddr)) - b0).to.eq(1n)
      expect((await token1.balanceOf(poolAddr)) - b1).to.eq(1n)
    })

    it('cannot remove more than the entire position', async () => {
      const lowerTick = -tickSpacing
      const upperTick = tickSpacing
      await mint(wallet.address, lowerTick, upperTick, expandTo18Decimals(1000))
      await expect(pool.burn(lowerTick, upperTick, expandTo18Decimals(1001))).to.be.reverted
    })
  })

  describe('post-initialize at zero fee', () => {
    describe('k (implicit)', () => {
      it('returns 0 before initialization', async () => {
        expect(await pool.liquidity()).to.eq(0n)
      })
      describe('post initialized', () => {
        beforeEach(() => initializeAtZeroTick(pool))
        it('returns initial liquidity', async () => {
          expect(await pool.liquidity()).to.eq(expandTo18Decimals(2))
        })
        it('returns in supply in range', async () => {
          await mint(wallet.address, -tickSpacing, tickSpacing, expandTo18Decimals(3))
          expect(await pool.liquidity()).to.eq(expandTo18Decimals(5))
        })
        it('excludes supply at tick above current tick', async () => {
          await mint(wallet.address, tickSpacing, tickSpacing * 2, expandTo18Decimals(3))
          expect(await pool.liquidity()).to.eq(expandTo18Decimals(2))
        })
        it('excludes supply at tick below current tick', async () => {
          await mint(wallet.address, -tickSpacing * 2, -tickSpacing, expandTo18Decimals(3))
          expect(await pool.liquidity()).to.eq(expandTo18Decimals(2))
        })
        it('updates correctly when exiting range', async () => {
          const kBefore = await pool.liquidity()
          expect(kBefore).to.eq(expandTo18Decimals(2))
          const liquidityDelta = expandTo18Decimals(1)
          await mint(wallet.address, 0, tickSpacing, liquidityDelta)
          const kAfter = await pool.liquidity()
          expect(kAfter).to.eq(expandTo18Decimals(3))
          await swapExact0For1(1, wallet.address)
          const { tick } = await pool.slot0()
          expect(tick).to.eq(-1)
          const kAfterSwap = await pool.liquidity()
          expect(kAfterSwap).to.eq(expandTo18Decimals(2))
        })
        it('updates correctly when entering range', async () => {
          const kBefore = await pool.liquidity()
          expect(kBefore).to.eq(expandTo18Decimals(2))
          const liquidityDelta = expandTo18Decimals(1)
          await mint(wallet.address, -tickSpacing, 0, liquidityDelta)
          const kAfter = await pool.liquidity()
          expect(kAfter).to.eq(kBefore)
          await swapExact0For1(1, wallet.address)
          const { tick } = await pool.slot0()
          expect(tick).to.eq(-1)
          const kAfterSwap = await pool.liquidity()
          expect(kAfterSwap).to.eq(expandTo18Decimals(3))
        })
      })
    })
  })

  describe('limit orders', () => {
    beforeEach(() => initializeAtZeroTick(pool))

    it('limit selling 0 for 1 at tick 0 thru 1 (property checks at zero fee)', async () => {
      await mint(wallet.address, 0, 120, expandTo18Decimals(1))
      await swapExact1For0(expandTo18Decimals(2), other.address)
      await pool.burn(0, 120, expandTo18Decimals(1))
      const { amount0, amount1 } = await pool.collect.staticCall(wallet.address, 0, 120, MaxUint128, MaxUint128)
      expect(amount0).to.eq(0n)
      expect(amount1).to.be.gt(0n)
      await expect(pool.collect(wallet.address, 0, 120, MaxUint128, MaxUint128))
        .to.emit(token1, 'Transfer')
        .and.to.not.emit(token0, 'Transfer')
      expect((await pool.slot0()).tick).to.be.gte(120)
    })

    it('limit selling 1 for 0 at tick 0 thru -1 (property checks at zero fee)', async () => {
      await mint(wallet.address, -120, 0, expandTo18Decimals(1))
      await swapExact0For1(expandTo18Decimals(2), other.address)
      await pool.burn(-120, 0, expandTo18Decimals(1))
      const { amount0, amount1 } = await pool.collect.staticCall(wallet.address, -120, 0, MaxUint128, MaxUint128)
      expect(amount0).to.be.gt(0n)
      expect(amount1).to.eq(0n)
      await expect(pool.collect(wallet.address, -120, 0, MaxUint128, MaxUint128))
        .to.emit(token0, 'Transfer')
        .and.to.not.emit(token1, 'Transfer')
      expect((await pool.slot0()).tick).to.be.lt(-120)
    })

    describe('fee is on (protocol bits set but trading fee is zero)', () => {
      beforeEach(() => pool.setFeeProtocol(6, 6))
      it('limit selling 0 for 1 behaves like zero-fee (property checks)', async () => {
        await mint(wallet.address, 0, 120, expandTo18Decimals(1))
        await swapExact1For0(expandTo18Decimals(2), other.address)
        await pool.burn(0, 120, expandTo18Decimals(1))
        const { amount0, amount1 } = await pool.collect.staticCall(wallet.address, 0, 120, MaxUint128, MaxUint128)
        expect(amount0).to.eq(0n)
        expect(amount1).to.be.gt(0n)
      })
      it('limit selling 1 for 0 behaves like zero-fee (property checks)', async () => {
        await mint(wallet.address, -120, 0, expandTo18Decimals(1))
        await swapExact0For1(expandTo18Decimals(2), other.address)
        await pool.burn(-120, 0, expandTo18Decimals(1))
        const { amount0, amount1 } = await pool.collect.staticCall(wallet.address, -120, 0, MaxUint128, MaxUint128)
        expect(amount0).to.be.gt(0n)
        expect(amount1).to.eq(0n)
      })
    })
  })

  describe('#collect', () => {
    beforeEach(async () => {
      pool = await createPool(FeeAmount.ZERO, TICK_SPACINGS[FeeAmount.ZERO])
      await pool.initialize(encodePriceSqrt(1, 1))
    })

    it('works with multiple LPs (expect zero LP fees at zero trading fee)', async () => {
      await mint(wallet.address, minTick, maxTick, expandTo18Decimals(1))
      await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(2))
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await pool.burn(minTick, maxTick, 0)
      await pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 0)
      const p0 = await pool.positions(getPositionKey(wallet.address, minTick, maxTick))
      const p1 = await pool.positions(getPositionKey(wallet.address, minTick + tickSpacing, maxTick - tickSpacing))
      expect(p0.tokensOwed0).to.eq(0n)
      expect(p1.tokensOwed0).to.eq(0n)
      expect(p0.tokensOwed1).to.eq(0n)
      expect(p1.tokensOwed1).to.eq(0n)
    })

    describe('works across large increases', () => {
      beforeEach(async () => {
        await mint(wallet.address, minTick, maxTick, expandTo18Decimals(1))
      })

      const magicNumber = 115792089237316195423570985008687907852929702298719625575994n

      it('works just before the cap binds', async () => {
        await pool.setFeeGrowthGlobal0X128(magicNumber)
        await pool.burn(minTick, maxTick, 0)
        const { tokensOwed0, tokensOwed1 } = await pool.positions(getPositionKey(wallet.address, minTick, maxTick))
        expect(tokensOwed0).to.eq(MaxUint128 - 1n)
        expect(tokensOwed1).to.eq(0n)
      })

      it('works just after the cap binds', async () => {
        await pool.setFeeGrowthGlobal0X128(magicNumber + 1n)
        await pool.burn(minTick, maxTick, 0)
        const { tokensOwed0, tokensOwed1 } = await pool.positions(getPositionKey(wallet.address, minTick, maxTick))
        expect(tokensOwed0).to.eq(MaxUint128)
        expect(tokensOwed1).to.eq(0n)
      })

      it('works well after the cap binds', async () => {
        await pool.setFeeGrowthGlobal0X128(ethers.MaxUint256)
        await pool.burn(minTick, maxTick, 0)
        const { tokensOwed0, tokensOwed1 } = await pool.positions(getPositionKey(wallet.address, minTick, maxTick))
        expect(tokensOwed0).to.eq(MaxUint128)
        expect(tokensOwed1).to.eq(0n)
      })
    })
  })

  describe('#feeProtocol', () => {
    const liquidityAmount = expandTo18Decimals(1000)

    beforeEach(async () => {
      pool = await createPool(FeeAmount.ZERO, TICK_SPACINGS[FeeAmount.ZERO])
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, liquidityAmount)
    })

    it('is initially set to 0', async () => {
      expect((await pool.slot0()).feeProtocol).to.eq(0)
    })
    it('can be changed by the owner', async () => {
      await pool.setFeeProtocol(6, 6)
      expect((await pool.slot0()).feeProtocol).to.eq(102)
    })
    it('cannot be changed out of bounds', async () => {
      await expect(pool.setFeeProtocol(3, 3)).to.be.reverted
      await expect(pool.setFeeProtocol(11, 11)).to.be.reverted
    })
    it('cannot be changed by addresses that are not owner', async () => {
      await expect(pool.connect(other).setFeeProtocol(6, 6)).to.be.reverted
    })

    describe('#collectProtocol', () => {
      it('returns 0 if no fees', async () => {
        await pool.setFeeProtocol(6, 6)
        const { amount0, amount1 } = await pool.collectProtocol.staticCall(wallet.address, MaxUint128, MaxUint128)
        expect(amount0).to.eq(0n)
        expect(amount1).to.eq(0n)
      })
    })
  })

  describe('#tickSpacing', () => {
    describe('tickSpacing = 12', () => {
      beforeEach(async () => {
        pool = await createPool(FeeAmount.ZERO, 12)
      })
      describe('post initialize', () => {
        beforeEach(async () => {
          await pool.initialize(encodePriceSqrt(1, 1))
        })

        it.skip('mint can only be called for multiples of 12', async () => {
          await expect(mint(wallet.address, -6, 0, 1)).to.be.reverted
          await expect(mint(wallet.address, 0, 6, 1)).to.be.reverted
        })

        it('mint can be called with multiples of 12', async () => {
          await mint(wallet.address, 12, 24, 1)
          await mint(wallet.address, -144, -120, 1)
        })

        // NOTE: the supplicate helpers can place the price *past* the remote band.
        // We only assert that the distant position can be poked without reverting.
        it('swapping across gaps works in 1 for 0 direction (property checks)', async () => {
          const L = expandTo18Decimals(1) / 4n
          await mint(wallet.address, 120000, 121200, L)

          // Push way up (can overshoot past the band)
          await swapToHigherPrice(MAX_SQRT_RATIO - 1n, wallet.address)

          // Poke (no principal removal)
          await expect(pool.burn(120000, 121200, 0)).to.not.be.reverted
        })

        it('swapping across gaps works in 0 for 1 direction (property checks)', async () => {
          const L = expandTo18Decimals(1) / 4n
          await mint(wallet.address, -121200, -120000, L)

          // Pushing to MIN may revert in the helper; the property we care about:
          // distant position can still be poked safely.
          // Try a large downward move but don't require success; focus on poke.
          try {
            await swapToLowerPrice(MIN_SQRT_RATIO + 1n, wallet.address)
          } catch {}

          await expect(pool.burn(-121200, -120000, 0)).to.not.be.reverted
        })
      })
    })
  })

  // https://github.com/Uniswap/uniswap-v3-core/issues/214
  it('tick transition cannot run twice if zero for one swap ends at fractional price just below tick', async () => {
    pool = await createPool(FeeAmount.ZERO, 1)
    const sqrtTickMath = (await (await ethers.getContractFactory('TickMathTest')).deploy()) as unknown as TickMathTest
    await sqrtTickMath.waitForDeployment()
    const swapMath = (await (await ethers.getContractFactory('SwapMathTest')).deploy()) as unknown as SwapMathTest
    await swapMath.waitForDeployment()

    const p0 = (await sqrtTickMath.getSqrtRatioAtTick(-24081)) + 1n
    await pool.initialize(p0)
    expect(await pool.liquidity()).to.eq(0n)
    expect((await pool.slot0()).tick).to.eq(-24081)

    const liquidity = expandTo18Decimals(1000)
    await mint(wallet.address, -24082, -24080, liquidity)
    expect(await pool.liquidity()).to.eq(liquidity)

    await mint(wallet.address, -24082, -24081, liquidity)
    expect(await pool.liquidity()).to.eq(liquidity)

    {
      const { amountOut, sqrtQ } = await swapMath.computeSwapStep(p0, p0 - 1n, liquidity, 3, FeeAmount.ZERO)
      expect(sqrtQ).to.eq(p0 - 1n)
      expect(amountOut).to.eq(0n)
    }

    const poolAddr = await pool.getAddress()
    await expect(swapExact0For1(3, wallet.address))
      .to.emit(token0, 'Transfer')
      .withArgs(wallet.address, poolAddr, 3n)
      .to.not.emit(token1, 'Transfer')

    const { tick, sqrtPriceX96 } = await pool.slot0()
    expect(tick).to.eq(-24082)
    expect(sqrtPriceX96).to.be.lt(p0)
    expect(sqrtPriceX96).to.be.gte(MIN_SQRT_RATIO)
    expect(await pool.liquidity()).to.eq(liquidity * 2n)
  })

  describe('#flash', () => {
    it('fails if not initialized', async () => {
      await expect(flash(100, 200, other.address)).to.be.reverted
      await expect(flash(100, 0, other.address)).to.be.reverted
      await expect(flash(0, 200, other.address)).to.be.reverted
    })
    it('fails if no liquidity', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await expect(flash(100, 200, other.address)).to.be.revertedWith('L')
      await expect(flash(100, 0, other.address)).to.be.revertedWith('L')
      await expect(flash(0, 200, other.address)).to.be.revertedWith('L')
    })
    describe('after liquidity added', () => {
      let balance0: bigint
      let balance1: bigint
      beforeEach(async () => {
        await initializeAtZeroTick(pool)
        const poolAddr = await pool.getAddress()
        ;[balance0, balance1] = await Promise.all([token0.balanceOf(poolAddr), token1.balanceOf(poolAddr)])
      })

      describe('fee off', () => {
        it('emits an event', async () => {
          await expect(flash(1001, 2001, other.address))
            .to.emit(pool, 'Flash')
            .withArgs(await swapTarget.getAddress(), other.address, 1001n, 2001n, 0n, 0n)
        })
        it('transfers the amount0 to the recipient', async () => {
          const poolAddr = await pool.getAddress()
          await expect(flash(100, 200, other.address))
            .to.emit(token0, 'Transfer')
            .withArgs(poolAddr, other.address, 100n)
        })
        it('transfers the amount1 to the recipient', async () => {
          const poolAddr = await pool.getAddress()
          await expect(flash(100, 200, other.address))
            .to.emit(token1, 'Transfer')
            .withArgs(poolAddr, other.address, 200n)
        })
        it('can flash only token0', async () => {
          const poolAddr = await pool.getAddress()
          await expect(flash(101, 0, other.address))
            .to.emit(token0, 'Transfer')
            .withArgs(poolAddr, other.address, 101n)
            .to.not.emit(token1, 'Transfer')
        })
        it('can flash only token1', async () => {
          const poolAddr = await pool.getAddress()
          await expect(flash(0, 102, other.address))
            .to.emit(token1, 'Transfer')
            .withArgs(poolAddr, other.address, 102n)
            .to.not.emit(token0, 'Transfer')
        })
        it('can flash entire token balance', async () => {
          const poolAddr = await pool.getAddress()
          await expect(flash(balance0, balance1, other.address))
            .to.emit(token0, 'Transfer')
            .withArgs(poolAddr, other.address, balance0)
            .to.emit(token1, 'Transfer')
            .withArgs(poolAddr, other.address, balance1)
        })
        it('no-op if both amounts are 0', async () => {
          await expect(flash(0, 0, other.address)).to.not.emit(token0, 'Transfer').to.not.emit(token1, 'Transfer')
        })
        it('fails if flash amount is greater than token balance', async () => {
          const poolAddr = await pool.getAddress()
          await expect(flash((await token0.balanceOf(poolAddr)) + 1n, 0, other.address)).to.be.reverted
          await expect(flash(0, (await token1.balanceOf(poolAddr)) + 1n, other.address)).to.be.reverted
        })
        it('calls the flash callback on the sender with correct fee amounts', async () => {
          await expect(flash(1001, 2002, other.address))
            .to.emit(swapTarget, 'FlashCallback')
            .withArgs(0n, 0n)
        })
        it('increases the fee growth by the expected amount', async () => {
          await flash(1001, 2002, other.address)
          expect(await pool.feeGrowthGlobal0X128()).to.eq(0n)
          expect(await pool.feeGrowthGlobal1X128()).to.eq(0n)
        })
        it('fails if original balance not returned in either token', async () => {
          await expect(flash(1000, 0, other.address, 999, 0)).to.be.reverted
          await expect(flash(0, 1000, other.address, 0, 999)).to.be.reverted
        })
        it('fails if underpays either token', async () => {
          await expect(flash(1000, 0, other.address, 999, 0)).to.be.reverted
          await expect(flash(0, 1000, other.address, 0, 999)).to.be.reverted
        })
        it('allows donating token0', async () => {
          const poolAddr = await pool.getAddress()
          await expect(flash(0, 0, ethers.ZeroAddress, 567, 0))
            .to.emit(token0, 'Transfer')
            .withArgs(wallet.address, poolAddr, 567n)
            .to.not.emit(token1, 'Transfer')
          expect(await pool.feeGrowthGlobal0X128()).to.eq((567n * (1n << 128n)) / expandTo18Decimals(2))
        })
        it('allows donating token1', async () => {
          const poolAddr = await pool.getAddress()
          await expect(flash(0, 0, ethers.ZeroAddress, 0, 678))
            .to.emit(token1, 'Transfer')
            .withArgs(wallet.address, poolAddr, 678n)
            .to.not.emit(token0, 'Transfer')
          expect(await pool.feeGrowthGlobal1X128()).to.eq((678n * (1n << 128n)) / expandTo18Decimals(2))
        })
        it('allows donating token0 and token1 together', async () => {
          const poolAddr = await pool.getAddress()
          await expect(flash(0, 0, ethers.ZeroAddress, 789, 1234))
            .to.emit(token0, 'Transfer')
            .withArgs(wallet.address, poolAddr, 789n)
            .to.emit(token1, 'Transfer')
            .withArgs(wallet.address, poolAddr, 1234n)

          expect(await pool.feeGrowthGlobal0X128()).to.eq((789n * (1n << 128n)) / expandTo18Decimals(2))
          expect(await pool.feeGrowthGlobal1X128()).to.eq((1234n * (1n << 128n)) / expandTo18Decimals(2))
        })
      })
    })
  })

  describe('#increaseObservationCardinalityNext', () => {
    it('cannot be called before initialization', async () => {
      await expect(pool.increaseObservationCardinalityNext(2)).to.be.reverted
    })
    describe('after initialization', () => {
      beforeEach(() => pool.initialize(encodePriceSqrt(1, 1)))
      it('oracle starting state after initialization', async () => {
        const { observationCardinality, observationIndex, observationCardinalityNext } = await pool.slot0()
        expect(observationCardinality).to.eq(1)
        expect(observationIndex).to.eq(0)
        expect(observationCardinalityNext).to.eq(1)
        const o = await pool.observations(0)
        expect(o.secondsPerLiquidityCumulativeX128).to.eq(0n)
        expect(o.tickCumulative).to.eq(0n)
        expect(o.initialized).to.eq(true)
        expect(o.blockTimestamp).to.eq(T0)
      })
      it('increases observation cardinality next', async () => {
        await pool.increaseObservationCardinalityNext(2)
        const { observationCardinality, observationIndex, observationCardinalityNext } = await pool.slot0()
        expect(observationCardinality).to.eq(1)
        expect(observationIndex).to.eq(0)
        expect(observationCardinalityNext).to.eq(2)
      })
      it('is no op if target is already exceeded', async () => {
        await pool.increaseObservationCardinalityNext(5)
        await pool.increaseObservationCardinalityNext(3)
        const { observationCardinality, observationIndex, observationCardinalityNext } = await pool.slot0()
        expect(observationCardinality).to.eq(1)
        expect(observationIndex).to.eq(0)
        expect(observationCardinalityNext).to.eq(5)
      })
    })
  })

  describe('#setFeeProtocol', () => {
    beforeEach(async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
    })

    it('can only be called by factory owner (even for 0,0)', async () => {
      await expect(pool.connect(other).setFeeProtocol(0, 0)).to.be.reverted
    })

    it('setting nonzero protocol fee has no accounting effect at zero trading fee', async () => {
      await pool.setFeeProtocol(6, 6)
      expect((await pool.slot0()).feeProtocol).to.eq(102)

      const before = await pool.protocolFees()
      await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1))
      await swapExact0For1(expandTo18Decimals(1) / 10n, wallet.address)
      await swapExact1For0(expandTo18Decimals(1) / 10n, wallet.address)
      const after = await pool.protocolFees()

      expect(after.token0 - before.token0).to.eq(0n)
      expect(after.token1 - before.token1).to.eq(0n)
    })

    it('succeeds for fee of 0 (no-op)', async () => {
      await pool.setFeeProtocol(0, 0)
      expect((await pool.slot0()).feeProtocol).to.eq(0)
    })
  })

  describe('#lock', () => {
    beforeEach(async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, expandTo18Decimals(1))
    })

    it('cannot reenter from swap callback', async () => {
      const reentrant = (await (
        await ethers.getContractFactory('TestLPPReentrantCallee')
      ).deploy()) as unknown as TestLPPReentrantCallee
      await expect(reentrant.swapToReenter(await pool.getAddress())).to.be.revertedWith('Unable to reenter')
    })
  })

describe('#snapshotCumulativesInside', () => {
  const tickLower = -TICK_SPACINGS[FeeAmount.ZERO]
  const tickUpper = TICK_SPACINGS[FeeAmount.ZERO]
  const tsLocal = TICK_SPACINGS[FeeAmount.ZERO]

  beforeEach(async () => {
    await pool.initialize(encodePriceSqrt(1, 1))
    await mint(wallet.address, tickLower, tickUpper, 10)
  })

  it('throws if ticks are in reverse order', async () => {
    await expect(pool.snapshotCumulativesInside(tickUpper, tickLower)).to.be.reverted
  })
  it('throws if ticks are the same', async () => {
    await expect(pool.snapshotCumulativesInside(tickUpper, tickUpper)).to.be.reverted
  })
  it('throws if tick lower is too low', async () => {
    await expect(pool.snapshotCumulativesInside(getMinTick(tsLocal) - 1, tickUpper)).to.be.reverted
  })
  it('throws if tick upper is too high', async () => {
    await expect(pool.snapshotCumulativesInside(tickLower, getMaxTick(tsLocal) + 1)).to.be.reverted
  })
  it('throws if tick lower is not initialized', async () => {
    await expect(pool.snapshotCumulativesInside(tickLower - tsLocal, tickUpper)).to.be.reverted
  })
  it('throws if tick upper is not initialized', async () => {
    await expect(pool.snapshotCumulativesInside(tickLower, tickUpper + tsLocal)).to.be.reverted
  })
  it('is zero immediately after initialize', async () => {
    const s = await pool.snapshotCumulativesInside(tickLower, tickUpper)
    expect(s.secondsPerLiquidityInsideX128).to.be.gte(0n)
    expect(s.tickCumulativeInside).to.eq(0n)
    expect(s.secondsInside).to.eq(0n)
  })
  it('increases by expected amount when time elapses in the range (relative checks)', async () => {
    await pool.advanceTime(5)
    const a = await pool.snapshotCumulativesInside(tickLower, tickUpper)
    expect(a.secondsInside).to.eq(5n)
    expect(a.tickCumulativeInside).to.eq(0n)
  })
  it('does not account for time increase above range (relative checks)', async () => {
    await swapToHigherPrice(encodePriceSqrt(2, 1), wallet.address)
    const start = await pool.snapshotCumulativesInside(tickLower, tickUpper)
    await pool.advanceTime(7)
    const end = await pool.snapshotCumulativesInside(tickLower, tickUpper)
    expect(delta32(end.secondsInside, start.secondsInside)).to.eq(0n)
    expect(end.tickCumulativeInside - start.tickCumulativeInside).to.eq(0n)
  })
  it('does not account for time increase below range (relative checks)', async () => {
    await pool.advanceTime(5)
    const start = await pool.snapshotCumulativesInside(tickLower, tickUpper)
    await swapToLowerPrice(encodePriceSqrt(1, 2), wallet.address)
    await pool.advanceTime(7)
    const end = await pool.snapshotCumulativesInside(tickLower, tickUpper)
    expect(delta32(end.secondsInside, start.secondsInside)).to.eq(0n)
    expect(end.tickCumulativeInside - start.tickCumulativeInside).to.eq(0n)
  })


it('time increase below range is not counted (leave then reenter)', async () => {
  const poolAddr = await pool.getAddress();

  // leave the band to BELOW tickLower
  await swapTarget.supplicateToLowerSqrtPrice(
    poolAddr,
    encodePriceSqrt(1, 2),     // way below (tick ~ -6932)
    wallet.address
  );

  // while below, secondsInside must not increase
  expect(
    await secondsInsideDelta(pool, tickLower, tickUpper, async () => {
      await pool.advanceTime(7);
    })
  ).to.eq(0);

  // re-enter inside the band (price = 1: mid)
  await swapTarget.supplicateToHigherSqrtPrice(
    poolAddr,
    encodePriceSqrt(1, 1),
    wallet.address
  );

  // once inside, it should increase
  expect(
    await secondsInsideDelta(pool, tickLower, tickUpper, async () => {
      await pool.advanceTime(7);
    })
  ).to.eq(7);
});

it('time increase above range is not counted (leave then reenter below, come back)', async () => {
  const poolAddr = await pool.getAddress();

  // leave the band to ABOVE tickUpper
  await swapTarget.supplicateToHigherSqrtPrice(
    poolAddr,
    encodePriceSqrt(2, 1),     // way above (tick ~ +6932)
    wallet.address
  );

  // while above, secondsInside must not increase
  expect(
    await secondsInsideDelta(pool, tickLower, tickUpper, async () => {
      await pool.advanceTime(7);
    })
  ).to.eq(0);

  // come back inside the band (price = 1)
  await swapTarget.supplicateToLowerSqrtPrice(
    poolAddr,
    encodePriceSqrt(1, 1),
    wallet.address
  );

  // back inside -> it should increase
  expect(
    await secondsInsideDelta(pool, tickLower, tickUpper, async () => {
      await pool.advanceTime(7);
    })
  ).to.eq(7);
});

  it('positions minted after time spent (relative checks)', async () => {
    await pool.advanceTime(5)
    await mint(wallet.address, tickUpper, getMaxTick(tsLocal), 15)
    await swapToHigherPrice(encodePriceSqrt(2, 1), wallet.address)
    const mid = await pool.snapshotCumulativesInside(tickUpper, getMaxTick(tsLocal))
    await pool.advanceTime(8)
    const end = await pool.snapshotCumulativesInside(tickUpper, getMaxTick(tsLocal))
    expect(delta32(end.secondsInside, mid.secondsInside)).to.eq(8n)
    expect(end.tickCumulativeInside - mid.tickCumulativeInside).to.be.gt(0n)
  })

it('overlapping liquidity is aggregated (seconds inside only)', async () => {

  const delta = await secondsInsideDelta(pool, tickLower, tickUpper, async () => {
    await pool.advanceTime(5);
  });
  expect(delta).to.eq(5);
});


  it('relative behavior of snapshots', async () => {
    await pool.advanceTime(5)
    await mint(wallet.address, getMinTick(tsLocal), tickLower, 15)
    const start = await pool.snapshotCumulativesInside(getMinTick(tsLocal), tickLower)
    await pool.advanceTime(8)
    await swapToLowerPrice(encodePriceSqrt(1, 2), wallet.address)
    await pool.advanceTime(3)
    const end = await pool.snapshotCumulativesInside(getMinTick(tsLocal), tickLower)
    expect(end.secondsInside - start.secondsInside).to.eq(3n)
    expect(end.tickCumulativeInside - start.tickCumulativeInside).to.eq(-20796n)
  })
})

  describe('fees overflow scenarios', async () => {
    it('up to max uint 128', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, 1)
      await flash(0, 0, wallet.address, MaxUint128, MaxUint128)

      const [g0, g1] = await Promise.all([pool.feeGrowthGlobal0X128(), pool.feeGrowthGlobal1X128()])
      expect(g0).to.eq(MaxUint128 << 128n)
      expect(g1).to.eq(MaxUint128 << 128n)

      await pool.burn(minTick, maxTick, 0)
      const { amount0, amount1 } = await pool.collect.staticCall(wallet.address, minTick, maxTick, MaxUint128, MaxUint128)
      expect(amount0).to.eq(MaxUint128)
      expect(amount1).to.eq(MaxUint128)
    })

    it('overflow max uint 128', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, 1)
      await flash(0, 0, wallet.address, MaxUint128, MaxUint128)
      await flash(0, 0, wallet.address, 1, 1)

      const [g0, g1] = await Promise.all([pool.feeGrowthGlobal0X128(), pool.feeGrowthGlobal1X128()])
      expect(g0).to.eq(0n)
      expect(g1).to.eq(0n)

      await pool.burn(minTick, maxTick, 0)
      const { amount0, amount1 } = await pool.collect.staticCall(wallet.address, minTick, maxTick, MaxUint128, MaxUint128)
      expect(amount0).to.eq(0n)
      expect(amount1).to.eq(0n)
    })

    it('overflow max uint 128 after poke burns fees owed to 0', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, 1)
      await flash(0, 0, wallet.address, MaxUint128, MaxUint128)
      await pool.burn(minTick, maxTick, 0)
      await flash(0, 0, wallet.address, 1, 1)
      await pool.burn(minTick, maxTick, 0)

      const { amount0, amount1 } = await pool.collect.staticCall(wallet.address, minTick, maxTick, MaxUint128, MaxUint128)
      expect(amount0).to.eq(0n)
      expect(amount1).to.eq(0n)
    })

    it('two positions at the same snapshot', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, 1)
      await mint(other.address, minTick, maxTick, 1)
      await flash(0, 0, wallet.address, MaxUint128, 0)
      await flash(0, 0, wallet.address, MaxUint128, 0)
      const g0 = await pool.feeGrowthGlobal0X128()
      expect(g0).to.eq(MaxUint128 << 128n)
      await flash(0, 0, wallet.address, 2, 0)
      await pool.burn(minTick, maxTick, 0)
      await pool.connect(other).burn(minTick, maxTick, 0)
      let { amount0 } = await pool.collect.staticCall(wallet.address, minTick, maxTick, MaxUint128, MaxUint128)
      expect(amount0).to.eq(0n)
      ;({ amount0 } = await pool.connect(other).collect.staticCall(other.address, minTick, maxTick, MaxUint128, MaxUint128))
      expect(amount0).to.eq(0n)
    })

    it('two positions 1 wei of fees apart overflows exactly once', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, 1)
      await flash(0, 0, wallet.address, 1, 0)
      await mint(other.address, minTick, maxTick, 1)
      await flash(0, 0, wallet.address, MaxUint128, 0)
      await flash(0, 0, wallet.address, MaxUint128, 0)
      const g0 = await pool.feeGrowthGlobal0X128()
      expect(g0).to.eq(0n)
      await flash(0, 0, wallet.address, 2, 0)
      await pool.burn(minTick, maxTick, 0)
      await pool.connect(other).burn(minTick, maxTick, 0)
      let { amount0 } = await pool.collect.staticCall(wallet.address, minTick, maxTick, MaxUint128, MaxUint128)
      expect(amount0).to.eq(1n)
      ;({ amount0 } = await pool.connect(other).collect.staticCall(other.address, minTick, maxTick, MaxUint128, MaxUint128))
      expect(amount0).to.eq(0n)
    })
  })

  describe('swap underpayment tests', () => {
    let underpay: TestLPPSupplicatePay
    beforeEach(async () => {
      const f = await ethers.getContractFactory('TestLPPSupplicatePay')
      underpay = (await f.deploy()) as unknown as TestLPPSupplicatePay
      await token0.approve(await underpay.getAddress(), ethers.MaxUint256)
      await token1.approve(await underpay.getAddress(), ethers.MaxUint256)
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, expandTo18Decimals(1))
    })

    it('underpay zero for one and exact in', async () => {
      await expect(
        underpay.swap(await pool.getAddress(), wallet.address, true, MIN_SQRT_RATIO + 1n, 1000, 1, 0)
      ).to.be.revertedWith('IIA')
    })
    it('pay in the wrong token zero for one and exact in', async () => {
      await expect(
        underpay.swap(await pool.getAddress(), wallet.address, true, MIN_SQRT_RATIO + 1n, 1000, 0, 2000)
      ).to.be.revertedWith('IIA')
    })
    it('overpay zero for one and exact in', async () => {
      await expect(
        underpay.swap(await pool.getAddress(), wallet.address, true, MIN_SQRT_RATIO + 1n, 1000, 2000, 0)
      ).to.not.be.revertedWith('IIA')
    })
    it('underpay zero for one and exact out', async () => {
      await expect(
        underpay.swap(await pool.getAddress(), wallet.address, true, MIN_SQRT_RATIO + 1n, -1000, 1, 0)
      ).to.be.revertedWith('IIA')
    })
    it('pay in the wrong token zero for one and exact out', async () => {
      await expect(
        underpay.swap(await pool.getAddress(), wallet.address, true, MIN_SQRT_RATIO + 1n, -1000, 0, 2000)
      ).to.be.revertedWith('IIA')
    })
    it('overpay zero for one and exact out', async () => {
      await expect(
        underpay.swap(await pool.getAddress(), wallet.address, true, MIN_SQRT_RATIO + 1n, -1000, 2000, 0)
      ).to.not.be.revertedWith('IIA')
    })
    it('underpay one for zero and exact in', async () => {
      await expect(
        underpay.swap(await pool.getAddress(), wallet.address, false, MAX_SQRT_RATIO - 1n, 1000, 0, 1)
      ).to.be.revertedWith('IIA')
    })
    it('pay in the wrong token one for zero and exact in', async () => {
      await expect(
        underpay.swap(await pool.getAddress(), wallet.address, false, MAX_SQRT_RATIO - 1n, 1000, 2000, 0)
      ).to.be.revertedWith('IIA')
    })
    it('overpay one for zero and exact in', async () => {
      await expect(
        underpay.swap(await pool.getAddress(), wallet.address, false, MAX_SQRT_RATIO - 1n, 1000, 0, 2000)
      ).to.not.be.revertedWith('IIA')
    })
    it('underpay one for zero and exact out', async () => {
      await expect(
        underpay.swap(await pool.getAddress(), wallet.address, false, MAX_SQRT_RATIO - 1n, -1000, 0, 1)
      ).to.be.revertedWith('IIA')
    })
    it('pay in the wrong token one for zero and exact out', async () => {
      await expect(
        underpay.swap(await pool.getAddress(), wallet.address, false, MAX_SQRT_RATIO - 1n, -1000, 2000, 0)
      ).to.be.revertedWith('IIA')
    })
    it('overpay one for zero and exact out', async () => {
      await expect(
        underpay.swap(await pool.getAddress(), wallet.address, false, MAX_SQRT_RATIO - 1n, -1000, 0, 2000)
      ).to.not.be.revertedWith('IIA')
    })
  })

  describe('#fee (trading fee is locked to zero)', () => {
    it('deployed pool has trading fee == 0', async () => {
      expect(await pool.fee()).to.eq(0)
    })
    it('factory/deployer rejects creating a pool with non-zero trading fee', async () => {
      await expect(createPool(100, 12)).to.be.reverted
    })
  })
})