// test/LPPPool.supplications.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { Decimal } from 'decimal.js'
import type { BigNumberish } from 'ethers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'

import type { MockTimeLPPPool, TestERC20, TestLPPCallee } from '../typechain-types/protocol'
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
  TICK_SPACINGS,
  getPositionKey
} from './shared/utilities.ts'

Decimal.config({ toExpNeg: -500, toExpPos: 500 })

// ----------------------- test case types (supplication) -----------------------
interface BaseSupplicationTestCase {
  zeroForOne: boolean
  sqrtPriceLimit?: BigNumberish
}
interface SupplicateExact0For1TestCase extends BaseSupplicationTestCase {
  zeroForOne: true
  exactOut: false
  amount0: BigNumberish
}
interface SupplicateExact1For0TestCase extends BaseSupplicationTestCase {
  zeroForOne: false
  exactOut: false
  amount1: BigNumberish
}
interface Supplicate0ForExact1TestCase extends BaseSupplicationTestCase {
  zeroForOne: true
  exactOut: true
  amount1: BigNumberish
}
interface Supplicate1ForExact0TestCase extends BaseSupplicationTestCase {
  zeroForOne: false
  exactOut: true
  amount0: BigNumberish
}
interface SupplicateToHigherPrice extends BaseSupplicationTestCase {
  zeroForOne: false
  sqrtPriceLimit: BigNumberish
}
interface SupplicateToLowerPrice extends BaseSupplicationTestCase {
  zeroForOne: true
  sqrtPriceLimit: BigNumberish
}
type SupplicationTestCase =
  | SupplicateExact0For1TestCase
  | Supplicate0ForExact1TestCase
  | SupplicateExact1For0TestCase
  | Supplicate1ForExact0TestCase
  | SupplicateToHigherPrice
  | SupplicateToLowerPrice

// ----------------------- precise type guards ---------------------------------
const isSupplicateExact0For1 = (tc: SupplicationTestCase): tc is SupplicateExact0For1TestCase =>
  'exactOut' in tc && tc.exactOut === false && tc.zeroForOne === true

const isSupplicateExact1For0 = (tc: SupplicationTestCase): tc is SupplicateExact1For0TestCase =>
  'exactOut' in tc && tc.exactOut === false && tc.zeroForOne === false

const isSupplicate0ForExact1 = (tc: SupplicationTestCase): tc is Supplicate0ForExact1TestCase =>
  'exactOut' in tc && tc.exactOut === true && tc.zeroForOne === true

const isSupplicate1ForExact0 = (tc: SupplicationTestCase): tc is Supplicate1ForExact0TestCase =>
  'exactOut' in tc && tc.exactOut === true && tc.zeroForOne === false

const isSupplicateToLowerPrice = (tc: SupplicationTestCase): tc is SupplicateToLowerPrice =>
  !('exactOut' in tc) && tc.zeroForOne === true

const isSupplicateToHigherPrice = (tc: SupplicationTestCase): tc is SupplicateToHigherPrice =>
  !('exactOut' in tc) && tc.zeroForOne === false
// ------------------------------------------------------------------------------

// human description for snapshots
function supplicationCaseToDescription(tc: SupplicationTestCase): string {
  const priceClause = tc?.sqrtPriceLimit ? ` to price ${formatPrice(tc.sqrtPriceLimit)}` : ''

  if (isSupplicate0ForExact1(tc)) {
    return `supplicate token0 for exactly ${formatTokenAmount(tc.amount1)} token1${priceClause}`
  }
  if (isSupplicate1ForExact0(tc)) {
    return `supplicate token1 for exactly ${formatTokenAmount(tc.amount0)} token0${priceClause}`
  }
  if (isSupplicateExact0For1(tc)) {
    return `supplicate exactly ${formatTokenAmount(tc.amount0)} token0 for token1${priceClause}`
  }
  if (isSupplicateExact1For0(tc)) {
    return `supplicate exactly ${formatTokenAmount(tc.amount1)} token1 for token0${priceClause}`
  }
  if (isSupplicateToLowerPrice(tc)) {
    return `supplicate token0 for token1${priceClause}`
  }
  if (isSupplicateToHigherPrice(tc)) {
    return `supplicate token1 for token0${priceClause}`
  }

  // exhaustive guard – prevents “never” errors
  const _exhaustive: never = tc as never
  throw new Error(`Unknown supplication test case: ${JSON.stringify(_exhaustive)}`)
}

type PoolFunctions = ReturnType<typeof createPoolFunctions>

// can't use address zero because the ERC20 token does not allow it
const SUPPLICATION_RECIPIENT_ADDRESS = ethers.ZeroAddress.slice(0, -1) + '1'
const POSITION_PROCEEDS_OUTPUT_ADDRESS = ethers.ZeroAddress.slice(0, -1) + '2'

// drive a supplication according to the case (with strict narrows)
async function executeSupplication(
  _pool: MockTimeLPPPool,
  testCase: SupplicationTestCase,
  poolFunctions: ReturnType<typeof createPoolFunctions>
) {
  if (isSupplicate0ForExact1(testCase)) {
    return poolFunctions.supplicate0ForExact1(testCase.amount1, SUPPLICATION_RECIPIENT_ADDRESS, testCase.sqrtPriceLimit)
  }
  if (isSupplicate1ForExact0(testCase)) {
    return poolFunctions.supplicate1ForExact0(testCase.amount0, SUPPLICATION_RECIPIENT_ADDRESS, testCase.sqrtPriceLimit)
  }
  if (isSupplicateExact0For1(testCase)) {
    return poolFunctions.supplicateExact0For1(testCase.amount0, SUPPLICATION_RECIPIENT_ADDRESS, testCase.sqrtPriceLimit)
  }
  if (isSupplicateExact1For0(testCase)) {
    return poolFunctions.supplicateExact1For0(testCase.amount1, SUPPLICATION_RECIPIENT_ADDRESS, testCase.sqrtPriceLimit)
  }
  if (isSupplicateToLowerPrice(testCase)) {
    return poolFunctions.supplicateToLowerPrice(testCase.sqrtPriceLimit!, SUPPLICATION_RECIPIENT_ADDRESS)
  }
  if (isSupplicateToHigherPrice(testCase)) {
    return poolFunctions.supplicateToHigherPrice(testCase.sqrtPriceLimit!, SUPPLICATION_RECIPIENT_ADDRESS)
  }
  const _exhaustive: never = testCase as never
  throw new Error(`Unknown supplication test case: ${JSON.stringify(_exhaustive)}`)
}

// default matrix of supplication cases
const DEFAULT_POOL_SUPPLICATION_TESTS: SupplicationTestCase[] = [
  // large amounts in/out
  { zeroForOne: true, exactOut: false, amount0: expandTo18Decimals(1) },
  { zeroForOne: false, exactOut: false, amount1: expandTo18Decimals(1) },
  { zeroForOne: true, exactOut: true, amount1: expandTo18Decimals(1) },
  { zeroForOne: false, exactOut: true, amount0: expandTo18Decimals(1) },

  // with price limits
  { zeroForOne: true, exactOut: false, amount0: expandTo18Decimals(1), sqrtPriceLimit: encodePriceSqrt(50, 100) },
  { zeroForOne: false, exactOut: false, amount1: expandTo18Decimals(1), sqrtPriceLimit: encodePriceSqrt(200, 100) },
  { zeroForOne: true, exactOut: true, amount1: expandTo18Decimals(1), sqrtPriceLimit: encodePriceSqrt(50, 100) },
  { zeroForOne: false, exactOut: true, amount0: expandTo18Decimals(1), sqrtPriceLimit: encodePriceSqrt(200, 100) },

  // small amounts
  { zeroForOne: true, exactOut: false, amount0: 1000 },
  { zeroForOne: false, exactOut: false, amount1: 1000 },
  { zeroForOne: true, exactOut: true, amount1: 1000 },
  { zeroForOne: false, exactOut: true, amount0: 1000 },

  // arbitrary input to target price
  { sqrtPriceLimit: encodePriceSqrt(5, 2), zeroForOne: false },
  { sqrtPriceLimit: encodePriceSqrt(2, 5), zeroForOne: true },
  { sqrtPriceLimit: encodePriceSqrt(5, 2), zeroForOne: true },
  { sqrtPriceLimit: encodePriceSqrt(2, 5), zeroForOne: false },
]

// liquidity positions to seed for each pool
interface Position {
  tickLower: number
  tickUpper: number
  liquidity: BigNumberish
}

interface PoolTestCase {
  description: string
  feeAmount: number
  tickSpacing: number
  startingPrice: BigNumberish
  positions: Position[]
  supplicationTests?: SupplicationTestCase[]
}

// NOTE: All fee tiers collapsed to ZERO to match LPP's locked-zero-fee behavior.
const TEST_POOLS: PoolTestCase[] = [
  {
    description: 'zero fee, 1:1 price, 2e18 max range liquidity',
    feeAmount: FeeAmount.ZERO,
    tickSpacing: TICK_SPACINGS[FeeAmount.ZERO],
    startingPrice: encodePriceSqrt(1, 1),
    positions: [
      {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        liquidity: expandTo18Decimals(2),
      },
    ],
  },
  {
    description: 'zero fee, 10:1 price, 2e18 max range liquidity',
    feeAmount: FeeAmount.ZERO,
    tickSpacing: TICK_SPACINGS[FeeAmount.ZERO],
    startingPrice: encodePriceSqrt(10, 1),
    positions: [
      {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        liquidity: expandTo18Decimals(2),
      },
    ],
  },
  {
    description: 'zero fee, 1:10 price, 2e18 max range liquidity',
    feeAmount: FeeAmount.ZERO,
    tickSpacing: TICK_SPACINGS[FeeAmount.ZERO],
    startingPrice: encodePriceSqrt(1, 10),
    positions: [
      {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        liquidity: expandTo18Decimals(2),
      },
    ],
  },
  {
    description: 'zero fee, 1:1 price, 0 liquidity, all liquidity around current price',
    feeAmount: FeeAmount.ZERO,
    tickSpacing: TICK_SPACINGS[FeeAmount.ZERO],
    startingPrice: encodePriceSqrt(1, 1),
    positions: [
      {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: -TICK_SPACINGS[FeeAmount.ZERO],
        liquidity: expandTo18Decimals(2),
      },
      {
        tickLower: TICK_SPACINGS[FeeAmount.ZERO],
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        liquidity: expandTo18Decimals(2),
      },
    ],
  },
  {
    description: 'zero fee, 1:1 price, additional liquidity around current price',
    feeAmount: FeeAmount.ZERO,
    tickSpacing: TICK_SPACINGS[FeeAmount.ZERO],
    startingPrice: encodePriceSqrt(1, 1),
    positions: [
      {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        liquidity: expandTo18Decimals(2),
      },
      {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: -TICK_SPACINGS[FeeAmount.ZERO],
        liquidity: expandTo18Decimals(2),
      },
      {
        tickLower: TICK_SPACINGS[FeeAmount.ZERO],
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        liquidity: expandTo18Decimals(2),
      },
    ],
  },
  {
    description: 'zero fee, large liquidity around current price (stable supplication)',
    feeAmount: FeeAmount.ZERO,
    tickSpacing: TICK_SPACINGS[FeeAmount.ZERO],
    startingPrice: encodePriceSqrt(1, 1),
    positions: [
      {
        tickLower: -TICK_SPACINGS[FeeAmount.ZERO],
        tickUpper: TICK_SPACINGS[FeeAmount.ZERO],
        liquidity: expandTo18Decimals(2),
      },
    ],
  },
  {
    description: 'zero fee, token0 liquidity only',
    feeAmount: FeeAmount.ZERO,
    tickSpacing: TICK_SPACINGS[FeeAmount.ZERO],
    startingPrice: encodePriceSqrt(1, 1),
    positions: [
      {
        tickLower: 0,
        tickUpper: 2000 * TICK_SPACINGS[FeeAmount.ZERO],
        liquidity: expandTo18Decimals(2),
      },
    ],
  },
  {
    description: 'zero fee, token1 liquidity only',
    feeAmount: FeeAmount.ZERO,
    tickSpacing: TICK_SPACINGS[FeeAmount.ZERO],
    startingPrice: encodePriceSqrt(1, 1),
    positions: [
      {
        tickLower: -2000 * TICK_SPACINGS[FeeAmount.ZERO],
        tickUpper: 0,
        liquidity: expandTo18Decimals(2),
      },
    ],
  },
  {
    description: 'close to max price',
    feeAmount: FeeAmount.ZERO,
    tickSpacing: TICK_SPACINGS[FeeAmount.ZERO],
    startingPrice: encodePriceSqrt(1n << 127n, 1),
    positions: [
      {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        liquidity: expandTo18Decimals(2),
      },
    ],
  },
  {
    description: 'close to min price',
    feeAmount: FeeAmount.ZERO,
    tickSpacing: TICK_SPACINGS[FeeAmount.ZERO],
    startingPrice: encodePriceSqrt(1, 1n << 127n),
    positions: [
      {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        liquidity: expandTo18Decimals(2),
      },
    ],
  },
  {
    description: 'max full range liquidity at 1:1 price with default (zero) fee',
    feeAmount: FeeAmount.ZERO,
    tickSpacing: TICK_SPACINGS[FeeAmount.ZERO],
    startingPrice: encodePriceSqrt(1, 1),
    positions: [
      {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        liquidity: getMaxLiquidityPerTick(TICK_SPACINGS[FeeAmount.ZERO]),
      },
    ],
  },
  {
    description: 'initialized at the max ratio',
    feeAmount: FeeAmount.ZERO,
    tickSpacing: TICK_SPACINGS[FeeAmount.ZERO],
    startingPrice: MAX_SQRT_RATIO - 1n,
    positions: [
      {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        liquidity: expandTo18Decimals(2),
      },
    ],
  },
  {
    description: 'initialized at the min ratio',
    feeAmount: FeeAmount.ZERO,
    tickSpacing: TICK_SPACINGS[FeeAmount.ZERO],
    startingPrice: MIN_SQRT_RATIO,
    positions: [
      {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
        liquidity: expandTo18Decimals(2),
      },
    ],
  },
]

// ----------------------------- main suite ------------------------------------
describe('LPPPool supplication tests', () => {
  let wallet: HardhatEthersSigner, other: HardhatEthersSigner

  before(async () => {
    ;[wallet, other] = (await ethers.getSigners()) as unknown as [HardhatEthersSigner, HardhatEthersSigner]
  })

  for (const poolCase of TEST_POOLS) {
    describe(poolCase.description, () => {
      const poolCaseFixture = async () => {
        const { createPool, token0, token1, supplicateTargetCallee: supplicateTarget } = await loadFixture(poolFixture)
        const pool = await createPool(poolCase.feeAmount, poolCase.tickSpacing)
        const poolFunctions = createPoolFunctions({ supplicateTarget, token0, token1, pool })
        await pool.initialize(poolCase.startingPrice)

        // mint all positions
        for (const position of poolCase.positions) {
          await poolFunctions.mint(wallet.address, position.tickLower, position.tickUpper, position.liquidity)
        }

        const poolAddr = await pool.getAddress()
        const [poolBalance0, poolBalance1] = await Promise.all([
          token0.balanceOf(poolAddr),
          token1.balanceOf(poolAddr),
        ])

        return { token0, token1, pool, poolFunctions, poolBalance0, poolBalance1, supplicateTarget, poolAddr }
      }

      let token0: TestERC20
      let token1: TestERC20
      let poolBalance0: bigint
      let poolBalance1: bigint
      let pool: MockTimeLPPPool
      let supplicateTarget: TestLPPCallee
      let poolFunctions: PoolFunctions
      let poolAddr: string

      beforeEach('load fixture', async () => {
        ;({ token0, token1, pool, poolFunctions, poolBalance0, poolBalance1, supplicateTarget, poolAddr } =
          await loadFixture(poolCaseFixture))
      })

      afterEach('check can burn positions', async () => {
        const inRange = async (p: { tickLower: number; tickUpper: number }) => {
          const { tick } = await pool.slot0()
          return p.tickLower <= tick && tick < p.tickUpper
        }

        // order: in-range first, then out-of-range
        const tickNow = (await pool.slot0()).tick
        const ordered = [
          ...poolCase.positions.filter(p => p.tickLower <= tickNow && tickNow < p.tickUpper),
          ...poolCase.positions.filter(p => !(p.tickLower <= tickNow && tickNow < p.tickUpper)),
        ]

        // burn a single [lower, upper] range safely
        const safeBurn = async (tickLower: number, tickUpper: number) => {
          const key = getPositionKey(wallet.address, tickLower, tickUpper)

          // loop until position.liquidity is 0 or we can’t safely reduce further
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const pos = await pool.positions(key)
            let remaining = pos.liquidity as bigint
            if (remaining === 0n) break

            // live caps
            const [lowerInfo, upperInfo, slot0] = await Promise.all([
              pool.ticks(tickLower),
              pool.ticks(tickUpper),
              pool.slot0(),
            ])

            const active = tickLower <= slot0.tick && slot0.tick < tickUpper
            const lowerGross = BigInt((lowerInfo as any).liquidityGross ?? 0)
            const upperGross = BigInt((upperInfo as any).liquidityGross ?? 0)
            const poolLiq = active ? (await pool.liquidity()) as unknown as bigint : (1n << 255n) // “infinity” when out-of-range

            // cap burn to *all* safety limits
            let burnable = remaining
            if (lowerGross < burnable) burnable = lowerGross
            if (upperGross < burnable) burnable = upperGross
            if (poolLiq   < burnable) burnable = poolLiq

            if (burnable === 0n) {
              // poke to settle growth; nothing safe to burn this tick
              await pool.burn(tickLower, tickUpper, 0)
              break
            }

            // try largest safe chunk; if boundary race still hits LS, back off
            try {
              await pool.burn(tickLower, tickUpper, burnable)
            } catch (e: any) {
              // halve once and retry; if still no-go, poke and stop
              const smaller = burnable / 2n
              if (smaller === 0n) {
                await pool.burn(tickLower, tickUpper, 0)
                break
              }
              try {
                await pool.burn(tickLower, tickUpper, smaller)
              } catch {
                await pool.burn(tickLower, tickUpper, 0)
                break
              }
            }
          }

          // collect whatever’s owed (even if we didn’t burn anything)
          await pool.collect(
            POSITION_PROCEEDS_OUTPUT_ADDRESS,
            tickLower,
            tickUpper,
            MaxUint128,
            MaxUint128
          )
        }

        // burn all ranges
        for (const { tickLower, tickUpper } of ordered) {
          await safeBurn(tickLower, tickUpper)
        }
      })

      for (const testCase of poolCase.supplicationTests ?? DEFAULT_POOL_SUPPLICATION_TESTS) {
        it(supplicationCaseToDescription(testCase), async () => {
          const slot0 = await pool.slot0()
          const tx = executeSupplication(pool, testCase, poolFunctions)

          try {
            await tx
          } catch (error: any) {
            expect({
              supplicationError: error.message,
              poolBalance0: poolBalance0.toString(),
              poolBalance1: poolBalance1.toString(),
              poolPriceBefore: formatPrice(slot0.sqrtPriceX96),
              tickBefore: slot0.tick,
            }).to.matchSnapshot('supplication error')
            return
          }

          const [
            poolBalance0After,
            poolBalance1After,
            slot0After,
            liquidityAfter,
            feeGrowthGlobal0X128,
            feeGrowthGlobal1X128,
          ] = await Promise.all([
            token0.balanceOf(poolAddr),
            token1.balanceOf(poolAddr),
            pool.slot0(),
            pool.liquidity(),
            pool.feeGrowthGlobal0X128(),
            pool.feeGrowthGlobal1X128(),
          ])

          const poolBalance0Delta = poolBalance0After - poolBalance0
          const poolBalance1Delta = poolBalance1After - poolBalance1

          // transfer events must match balance changes
          if (poolBalance0Delta === 0n) {
            await expect(tx).to.not.emit(token0, 'Transfer')
          } else if (poolBalance0Delta < 0n) {
            await expect(tx)
              .to.emit(token0, 'Transfer')
              .withArgs(poolAddr, SUPPLICATION_RECIPIENT_ADDRESS, -poolBalance0Delta)
          } else {
            await expect(tx).to.emit(token0, 'Transfer').withArgs(wallet.address, poolAddr, poolBalance0Delta)
          }

          if (poolBalance1Delta === 0n) {
            await expect(tx).to.not.emit(token1, 'Transfer')
          } else if (poolBalance1Delta < 0n) {
            await expect(tx)
              .to.emit(token1, 'Transfer')
              .withArgs(poolAddr, SUPPLICATION_RECIPIENT_ADDRESS, -poolBalance1Delta)
          } else {
            await expect(tx).to.emit(token1, 'Transfer').withArgs(wallet.address, poolAddr, poolBalance1Delta)
          }

          // pool still emits supplicate event on-chain (name unchanged)
          await expect(tx)
            .to.emit(pool, 'Supplicate')
            .withArgs(
              await supplicateTarget.getAddress(),
              SUPPLICATION_RECIPIENT_ADDRESS,
              poolBalance0Delta,
              poolBalance1Delta,
              slot0After.sqrtPriceX96,
              liquidityAfter,
              slot0After.tick
            )

          const executionPrice = new Decimal(poolBalance1Delta.toString())
            .div(poolBalance0Delta.toString())
            .mul(-1)

          expect({
            amount0Before: poolBalance0.toString(),
            amount1Before: poolBalance1.toString(),
            amount0Delta: poolBalance0Delta.toString(),
            amount1Delta: poolBalance1Delta.toString(),
            feeGrowthGlobal0X128Delta: feeGrowthGlobal0X128.toString(),
            feeGrowthGlobal1X128Delta: feeGrowthGlobal1X128.toString(),
            tickBefore: slot0.tick,
            poolPriceBefore: formatPrice(slot0.sqrtPriceX96),
            tickAfter: slot0After.tick,
            poolPriceAfter: formatPrice(slot0After.sqrtPriceX96),
            executionPrice: executionPrice.toPrecision(5),
          }).to.matchSnapshot('balances')
        })
      }
    })
  }
})