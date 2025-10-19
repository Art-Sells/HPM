// test/LPPPool.arbitrage.spec.ts
import Decimal from 'decimal.js'
import hre from 'hardhat'
const { ethers } = hre

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'

import type { MockTimeLPPPool } from '../typechain-types/protocol'
import type { TickMathTest } from '../typechain-types/protocol'
import type { LPPPoolSwapTest } from '../typechain-types/protocol'
import { expect } from './shared/expect.ts'

import { poolFixture } from './shared/fixtures.ts'
import { formatPrice, formatTokenAmount } from './shared/format.ts'

import {
  createPoolFunctions,
  encodePriceSqrt,
  expandTo18Decimals,
  FeeAmount,
  getMaxLiquidityPerTick,
  getMaxTick,
  getMinTick,
  MAX_SQRT_RATIO,
  MaxUint128,
  MIN_SQRT_RATIO,
  type MintFunction,
  type SwapFunction,
  TICK_SPACINGS,
} from './shared/utilities.ts'

const asNum = (x: bigint | number) => (typeof x === 'bigint' ? Number(x) : x)
// ethers v6 bigints & Decimal config
Decimal.config({ toExpNeg: -500, toExpPos: 500 })

function applySqrtRatioBipsHundredthsDelta(sqrtRatio: bigint, bipsHundredths: number): bigint {
  // new = floor( sqrtRatio * sqrt( (1e6 + bips) / 1e6 ) )
  const r = new Decimal(sqrtRatio.toString())
  const factor = new Decimal(1_000_000 + bipsHundredths).div(1_000_000).sqrt()
  return BigInt(r.mul(factor).floor().toString())
}

describe('LPPPool arbitrage tests', () => {
  let wallet: HardhatEthersSigner
  let arbitrageur: HardhatEthersSigner

  before(async () => {
    ;[wallet, arbitrageur] = (await ethers.getSigners()) as HardhatEthersSigner[]
  })

  // protocol fee tests: same as before
  for (const feeProtocol of [0, 6]) {
    describe(`protocol fee = ${feeProtocol};`, () => {
      const startingPrice = encodePriceSqrt(1n, 1n)
      const startingTick = 0
      const feeAmount = FeeAmount.ZERO
      const tickSpacing = TICK_SPACINGS[feeAmount]
      const minTick = getMinTick(tickSpacing)
      const maxTick = getMaxTick(tickSpacing)

      for (const passiveLiquidity of [
        expandTo18Decimals(1) / 100n,
        expandTo18Decimals(1),
        expandTo18Decimals(10),
        expandTo18Decimals(100),
      ]) {
        describe(`passive liquidity of ${formatTokenAmount(passiveLiquidity)}`, () => {
          const arbTestFixture = async () => {
            // poolFixture originally used waffle's provider; pass Hardhat's instead
            const fix = await (poolFixture as any)([wallet], ethers.provider)

            const pool = await fix.createPool(feeAmount, tickSpacing)

            await fix.token0.transfer(await arbitrageur.getAddress(), 1n << 254n)
            await fix.token1.transfer(await arbitrageur.getAddress(), 1n << 254n)

            const {
              swapExact0For1,
              swapToHigherPrice,
              swapToLowerPrice,
              swapExact1For0,
              mint,
            } = await createPoolFunctions({
              swapTarget: fix.swapTargetCallee,
              token0: fix.token0,
              token1: fix.token1,
              pool,
            })

            const testerFactory = await ethers.getContractFactory('LPPPoolSwapTest')
            const tester = (await testerFactory.deploy()) as unknown as LPPPoolSwapTest
            await tester.waitForDeployment()

            const tickMathFactory = await ethers.getContractFactory('TickMathTest')
            const tickMath = (await tickMathFactory.deploy()) as unknown as TickMathTest
            await tickMath.waitForDeployment()

            await fix.token0.approve(await tester.getAddress(), ethers.MaxUint256)
            await fix.token1.approve(await tester.getAddress(), ethers.MaxUint256)

            await pool.initialize(startingPrice)
            if (feeProtocol !== 0) await pool.setFeeProtocol(feeProtocol, feeProtocol)
            await mint(await wallet.getAddress(), minTick, maxTick, passiveLiquidity)

            const slot = await pool.slot0()
            expect(slot.tick).to.eq(startingTick)
            expect(slot.sqrtPriceX96).to.eq(startingPrice)

            return { pool, swapExact0For1, mint, swapToHigherPrice, swapToLowerPrice, swapExact1For0, tester, tickMath }
          }

          let swapExact0For1: SwapFunction
          let swapToHigherPrice: SwapFunction
          let swapToLowerPrice: SwapFunction
          let swapExact1For0: SwapFunction
          let pool: MockTimeLPPPool
          let mint: MintFunction
          let tester: LPPPoolSwapTest
          let tickMath: TickMathTest

          beforeEach('load the fixture', async () => {
            ({
              swapExact0For1,
              pool,
              mint,
              swapToHigherPrice,
              swapToLowerPrice,
              swapExact1For0,
              tester,
              tickMath,
            } = await loadFixture(arbTestFixture))
          })

          async function simulateSwap(
            zeroForOne: boolean,
            amountSpecified: bigint,
            sqrtPriceLimitX96?: bigint
          ): Promise<{
            executionPrice: bigint
            nextSqrtRatio: bigint
            amount0Delta: bigint
            amount1Delta: bigint
          }> {
            const { amount0Delta, amount1Delta, nextSqrtRatio } = await tester.getSwapResult.staticCall(
              await pool.getAddress(),
              zeroForOne,
              amountSpecified,
              sqrtPriceLimitX96 ?? (zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n)
            )

            const executionPrice = zeroForOne
              ? encodePriceSqrt(amount1Delta, -amount0Delta)
              : encodePriceSqrt(-amount1Delta, amount0Delta)

            return { executionPrice, nextSqrtRatio, amount0Delta, amount1Delta }
          }

          for (const { zeroForOne, assumedTruePriceAfterSwap, inputAmount, description } of [
            {
              description: 'exact input of 10e18 token0 with starting price of 1.0 and true price of 0.98',
              zeroForOne: true,
              inputAmount: expandTo18Decimals(10),
              assumedTruePriceAfterSwap: encodePriceSqrt(98n, 100n),
            },
            {
              description: 'exact input of 10e18 token0 with starting price of 1.0 and true price of 1.01',
              zeroForOne: true,
              inputAmount: expandTo18Decimals(10),
              assumedTruePriceAfterSwap: encodePriceSqrt(101n, 100n),
            },
          ]) {
            describe(description, () => {
              function valueToken1(arbBalance0: bigint, arbBalance1: bigint) {
                // price^2 * bal0 / 2^192 + bal1  (Q64.96 squared)
                return (assumedTruePriceAfterSwap * assumedTruePriceAfterSwap * arbBalance0) / (1n << 192n) + arbBalance1
              }

              it('not sandwiched', async () => {
                const { executionPrice, amount1Delta, amount0Delta } = await simulateSwap(zeroForOne, inputAmount)
                if (zeroForOne) {
                  await swapExact0For1(inputAmount, await wallet.getAddress())
                } else {
                  await swapExact1For0(inputAmount, await wallet.getAddress())
                }

                const slot = await pool.slot0()
                expect({
                  executionPrice: formatPrice(executionPrice),
                  amount0Delta: formatTokenAmount(amount0Delta),
                  amount1Delta: formatTokenAmount(amount1Delta),
                  priceAfter: formatPrice(slot.sqrtPriceX96),
                }).to.matchSnapshot()
              })

              it('sandwiched with swap to execution price then mint max liquidity/target/burn max liquidity', async () => {
                const { executionPrice } = await simulateSwap(zeroForOne, inputAmount)

                const firstTickAboveMarginalPrice = zeroForOne
                  ? Math.ceil(
                      asNum(
                        await tickMath.getTickAtSqrtRatio(
                          applySqrtRatioBipsHundredthsDelta(executionPrice, feeAmount)
                        )
                      ) / tickSpacing
                    ) * tickSpacing
                  : Math.floor(
                      asNum(
                        await tickMath.getTickAtSqrtRatio(
                          applySqrtRatioBipsHundredthsDelta(executionPrice, -feeAmount)
                        )
                      ) / tickSpacing
                    ) * tickSpacing

                const tickAfterFirstTickAboveMarginPrice = zeroForOne
                  ? firstTickAboveMarginalPrice - tickSpacing
                  : firstTickAboveMarginalPrice + tickSpacing

                const priceSwapStart = await tickMath.getSqrtRatioAtTick(firstTickAboveMarginalPrice)

                let arbBalance0: bigint = 0n
                let arbBalance1: bigint = 0n

                // first frontrun to the first tick before the execution price
                const {
                  amount0Delta: frontrunDelta0,
                  amount1Delta: frontrunDelta1,
                  executionPrice: frontrunExecutionPrice,
                } = await simulateSwap(zeroForOne, ethers.MaxUint256 / 2n, priceSwapStart)

                arbBalance0 -= frontrunDelta0
                arbBalance1 -= frontrunDelta1

                if (zeroForOne) {
                  await swapToLowerPrice(priceSwapStart, await arbitrageur.getAddress())
                } else {
                  await swapToHigherPrice(priceSwapStart, await arbitrageur.getAddress())
                }

                const profitToken1AfterFrontRun = valueToken1(arbBalance0, arbBalance1)

                const tickLower = zeroForOne ? tickAfterFirstTickAboveMarginPrice : firstTickAboveMarginalPrice
                const tickUpper = zeroForOne ? firstTickAboveMarginalPrice : tickAfterFirstTickAboveMarginPrice

                // deposit max liquidity at the tick
                const mintReceipt = await (await mint(await wallet.getAddress(), tickLower, tickUpper, getMaxLiquidityPerTick(tickSpacing))).wait()

                // parse Mint event
                const iface = (pool as any).interface
                const parsed = mintReceipt.logs
                  .map((l: any) => { try { return iface.parseLog(l) } catch { return null } })
                  .find((p: any) => p && p.name === 'Mint')

                const amount0Mint = parsed!.args.amount0 as bigint
                const amount1Mint = parsed!.args.amount1 as bigint

                arbBalance0 -= amount0Mint
                arbBalance1 -= amount1Mint

                // execute the user's swap
                const { executionPrice: executionPriceAfterFrontrun } = await simulateSwap(zeroForOne, inputAmount)
                if (zeroForOne) {
                  await swapExact0For1(inputAmount, await wallet.getAddress())
                } else {
                  await swapExact1For0(inputAmount, await wallet.getAddress())
                }

                // burn the arb's liquidity
                const { amount0: amount0Burn, amount1: amount1Burn } = await (pool as any).burn.staticCall(
                  tickLower,
                  tickUpper,
                  getMaxLiquidityPerTick(tickSpacing)
                )
                await pool.burn(tickLower, tickUpper, getMaxLiquidityPerTick(tickSpacing))

                arbBalance0 += amount0Burn
                arbBalance1 += amount1Burn

                // collect fees
                const {
                  amount0: amount0CollectAndBurn,
                  amount1: amount1CollectAndBurn,
                } = await (pool as any).collect.staticCall(
                  await arbitrageur.getAddress(),
                  tickLower,
                  tickUpper,
                  MaxUint128,
                  MaxUint128
                )
                const amount0Collect = (amount0CollectAndBurn as bigint) - (amount0Burn as bigint)
                const amount1Collect = (amount1CollectAndBurn as bigint) - (amount1Burn as bigint)

                arbBalance0 += amount0Collect
                arbBalance1 += amount1Collect

                const profitToken1AfterSandwich = valueToken1(arbBalance0, arbBalance1)

                // backrun the swap to true price
                const priceToSwapTo = zeroForOne
                  ? applySqrtRatioBipsHundredthsDelta(assumedTruePriceAfterSwap, -feeAmount)
                  : applySqrtRatioBipsHundredthsDelta(assumedTruePriceAfterSwap, feeAmount)

                const {
                  amount0Delta: backrunDelta0,
                  amount1Delta: backrunDelta1,
                  executionPrice: backrunExecutionPrice,
                } = await simulateSwap(!zeroForOne, ethers.MaxUint256 / 2n, priceToSwapTo)

                await swapToHigherPrice(priceToSwapTo, await wallet.getAddress())
                arbBalance0 -= backrunDelta0
                arbBalance1 -= backrunDelta1

                const slot = await pool.slot0()
                expect({
                  sandwichedPrice: formatPrice(executionPriceAfterFrontrun),
                  arbBalanceDelta0: formatTokenAmount(arbBalance0),
                  arbBalanceDelta1: formatTokenAmount(arbBalance1),
                  profit: {
                    final: formatTokenAmount(valueToken1(arbBalance0, arbBalance1)),
                    afterFrontrun: formatTokenAmount(profitToken1AfterFrontRun),
                    afterSandwich: formatTokenAmount(profitToken1AfterSandwich),
                  },
                  backrun: {
                    executionPrice: formatPrice(backrunExecutionPrice),
                    delta0: formatTokenAmount(backrunDelta0),
                    delta1: formatTokenAmount(backrunDelta1),
                  },
                  frontrun: {
                    executionPrice: formatPrice(frontrunExecutionPrice),
                    delta0: formatTokenAmount(frontrunDelta0),
                    delta1: formatTokenAmount(frontrunDelta1),
                  },
                  collect: {
                    amount0: formatTokenAmount(amount0Collect),
                    amount1: formatTokenAmount(amount1Collect),
                  },
                  burn: {
                    amount0: formatTokenAmount(amount0Burn),
                    amount1: formatTokenAmount(amount1Burn),
                  },
                  mint: {
                    amount0: formatTokenAmount(amount0Mint),
                    amount1: formatTokenAmount(amount1Mint),
                  },
                  finalPrice: formatPrice(slot.sqrtPriceX96),
                }).to.matchSnapshot()
              })

              it('backrun to true price after swap only', async () => {
                let arbBalance0: bigint = 0n
                let arbBalance1: bigint = 0n

                if (zeroForOne) {
                  await swapExact0For1(inputAmount, await wallet.getAddress())
                } else {
                  await swapExact1For0(inputAmount, await wallet.getAddress())
                }

                // swap to the marginal price = true price
                const priceToSwapTo = zeroForOne
                  ? applySqrtRatioBipsHundredthsDelta(assumedTruePriceAfterSwap, -feeAmount)
                  : applySqrtRatioBipsHundredthsDelta(assumedTruePriceAfterSwap, feeAmount)

                const {
                  amount0Delta: backrunDelta0,
                  amount1Delta: backrunDelta1,
                  executionPrice: backrunExecutionPrice,
                } = await simulateSwap(!zeroForOne, ethers.MaxUint256 / 2n, priceToSwapTo)

                if (zeroForOne) {
                  await swapToHigherPrice(priceToSwapTo, await wallet.getAddress())
                } else {
                  await swapToLowerPrice(priceToSwapTo, await wallet.getAddress())
                }

                arbBalance0 -= backrunDelta0
                arbBalance1 -= backrunDelta1

                const slot = await pool.slot0()
                expect({
                  arbBalanceDelta0: formatTokenAmount(arbBalance0),
                  arbBalanceDelta1: formatTokenAmount(arbBalance1),
                  profit: {
                    final: formatTokenAmount((assumedTruePriceAfterSwap * assumedTruePriceAfterSwap * arbBalance0) / (1n << 192n) + arbBalance1),
                  },
                  backrun: {
                    executionPrice: formatPrice(backrunExecutionPrice),
                    delta0: formatTokenAmount(backrunDelta0),
                    delta1: formatTokenAmount(backrunDelta1),
                  },
                  finalPrice: formatPrice(slot.sqrtPriceX96),
                }).to.matchSnapshot()
              })
            })
          }
        })
      }
    })
  }
})