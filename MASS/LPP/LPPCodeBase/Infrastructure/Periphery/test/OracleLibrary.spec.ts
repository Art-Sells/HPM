// test/OracleLibrary.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import type { ContractFactory, BaseContract, BigNumberish } from 'ethers'
import { MaxUint256 } from 'ethers'

import type { OracleTest, TestERC20 } from '../typechain-types/periphery'
import { expandTo18Decimals } from './shared/expandTo18Decimals.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'

describe('OracleLibrary', () => {
  let tokens: TestERC20[]
  let oracle: OracleTest

  // v6: use bigint instead of BigNumber
  const BN0 = 0n

  async function oracleTestFixture() {
    const tokenFactory = await ethers.getContractFactory('TestERC20')

    // do not use MaxUint256 to avoid overflow; use half
    const half = MaxUint256 / 2n

    const t0 = (await tokenFactory.deploy(half)) as unknown as TestERC20
    const t1 = (await tokenFactory.deploy(half)) as unknown as TestERC20
    const t2 = (await tokenFactory.deploy(half)) as unknown as TestERC20

    const toks = [t0, t1, t2].sort(
      (a, b) => (a.target!.toString().toLowerCase() < b.target!.toString().toLowerCase() ? -1 : 1)
    )

    const oracleFactory = await ethers.getContractFactory('OracleTest')
    const oracle = (await oracleFactory.deploy()) as unknown as OracleTest

    return { tokens: toks as TestERC20[], oracle }
  }

  beforeEach('deploy fixture', async () => {
    ({ tokens, oracle } = await loadFixture(oracleTestFixture))
  })

  describe('#consult', () => {
    let mockObservableFactory: ContractFactory

    before('create mockObservableFactory', async () => {
      mockObservableFactory = await ethers.getContractFactory('MockObservable')
    })

    it('reverts when period is 0', async () => {
      await expect(oracle.consult(oracle.target, 0)).to.be.revertedWith('BP')
    })

    it('correct output when tick is 0', async () => {
      const period = 3
      const secondsPerLiqCumulatives: [BigNumberish, BigNumberish] = [10n, 20n]
      const mockObservable = await observableWith({
        period,
        tickCumulatives: [12n, 12n],
        secondsPerLiqCumulatives,
      })
      const { arithmeticMeanTick, harmonicMeanLiquidity } = await oracle.consult(mockObservable.target, period)

      expect(arithmeticMeanTick).to.equal(0)
      expect(harmonicMeanLiquidity).to.equal(calculateHarmonicAvgLiq(period, secondsPerLiqCumulatives))
    })

    it('correct rounding for .5 negative tick', async () => {
      const period = 4
      const secondsPerLiqCumulatives: [BigNumberish, BigNumberish] = [10n, 15n]
      const mockObservable = await observableWith({
        period,
        tickCumulatives: [-10, -12], // ticks can be negative (int24)
        secondsPerLiqCumulatives,
      })

      const { arithmeticMeanTick, harmonicMeanLiquidity } = await oracle.consult(mockObservable.target, period)

      expect(arithmeticMeanTick).to.equal(-1) // floor toward -inf
      expect(harmonicMeanLiquidity).to.equal(calculateHarmonicAvgLiq(period, secondsPerLiqCumulatives))
    })

    it('correct output for liquidity overflow', async () => {
      const period = 1
      const secondsPerLiqCumulatives: [BigNumberish, BigNumberish] = [10n, 11n]
      const mockObservable = await observableWith({
        period,
        tickCumulatives: [12n, 12n],
        secondsPerLiqCumulatives,
      })

      const { arithmeticMeanTick, harmonicMeanLiquidity } = await oracle.consult(mockObservable.target, period)

      expect(arithmeticMeanTick).to.equal(0)
      // ensure <= uint128 max
      expect(harmonicMeanLiquidity).to.equal((1n << 128n) - 1n)
    })

    function calculateHarmonicAvgLiq(period: number, secondsPerLiqCumulatives: [BigNumberish, BigNumberish]) {
      const [s0, s1] = secondsPerLiqCumulatives.map((x) => BigInt(x))
      const delta = s1 - s0
      const maxUint160 = (1n << 160n) - 1n
      return (maxUint160 * BigInt(period)) / (delta << 32n)
    }

    function observableWith({
      period,
      tickCumulatives,
      secondsPerLiqCumulatives,
    }: {
      period: number
      tickCumulatives: [BigNumberish, BigNumberish] // allow ints
      secondsPerLiqCumulatives: [BigNumberish, BigNumberish]
    }) {
      // ticks come as numbers (can be negative); secondsPerLiq as BigNumberish
      const ticks = tickCumulatives.map((t) => Number(t)) as [number, number]
      const spl = secondsPerLiqCumulatives.map((x) => BigInt(x)) as [bigint, bigint]
      return mockObservableFactory.deploy([period, 0], ticks, spl)
    }
  })

  describe('#getQuoteAtTick', () => {
    it('token0: returns correct value when tick = 0', async () => {
      const quoteAmount = await oracle.getQuoteAtTick(0, expandTo18Decimals(1), tokens[0].target, tokens[1].target)
      expect(quoteAmount).to.equal(expandTo18Decimals(1))
    })

    it('token1: returns correct value when tick = 0', async () => {
      const quoteAmount = await oracle.getQuoteAtTick(0, expandTo18Decimals(1), tokens[1].target, tokens[0].target)
      expect(quoteAmount).to.equal(expandTo18Decimals(1))
    })

    it('token0: correct at min tick | 0 < sqrtRatioX96 <= uint128.max', async () => {
      const quoteAmount = await oracle.getQuoteAtTick(
        -887272,
        (1n << 128n) - 1n,
        tokens[0].target,
        tokens[1].target
      )
      expect(quoteAmount).to.equal(1n)
    })

    it('token1: correct at min tick | 0 < sqrtRatioX96 <= uint128.max', async () => {
      const quoteAmount = await oracle.getQuoteAtTick(
        -887272,
        (1n << 128n) - 1n,
        tokens[1].target,
        tokens[0].target
      )
      expect(quoteAmount).to.equal(
        115783384738768196242144082653949453838306988932806144552194799290216044976282n
      )
    })

    it('token0: correct at max tick | sqrtRatioX96 > uint128.max', async () => {
      const quoteAmount = await oracle.getQuoteAtTick(
        887272,
        (1n << 128n) - 1n,
        tokens[0].target,
        tokens[1].target
      )
      expect(quoteAmount).to.equal(
        115783384785599357996676985412062652720342362943929506828539444553934033845703n
      )
    })

    it('token1: correct at max tick | sqrtRatioX96 > uint128.max', async () => {
      const quoteAmount = await oracle.getQuoteAtTick(
        887272,
        (1n << 128n) - 1n,
        tokens[1].target,
        tokens[0].target
      )
      expect(quoteAmount).to.equal(1n)
    })

    it('gas test', async () => {
      await snapshotGasCost(
        oracle.getGasCostOfGetQuoteAtTick(10, expandTo18Decimals(1), tokens[0].target, tokens[1].target)
      )
    })
  })

  describe('#getOldestObservationSecondsAgo', () => {
    let mockObservationsFactory: ContractFactory

    const emptySPL = [0n, 0n, 0n, 0n]               // bigint
    const emptyTickCumulatives = [0, 0, 0, 0]        // numbers (signed)
    const emptyTick = 0
    const emptyLiquidity = 0

    const runOldestObservationsTest = async (
      blockTimestamps: number[],
      initializeds: boolean[],
      observationCardinality: number,
      observationIndex: number
    ) => {
      const mockObservations = await mockObservationsFactory.deploy(
        blockTimestamps,
        emptyTickCumulatives,
        emptySPL,
        initializeds,
        emptyTick,
        observationCardinality,
        observationIndex,
        false,
        emptyLiquidity
      )

      const result = await oracle.getOldestObservationSecondsAgo(mockObservations.target)

      let secondsAgo: number
      const cur = Number(result.currentTimestamp)

      if (initializeds[(observationIndex + 1) % observationCardinality]) {
        secondsAgo = cur - blockTimestamps[(observationIndex + 1) % observationCardinality]
      } else {
        secondsAgo = cur - blockTimestamps[0]
      }
      if (secondsAgo < 0) secondsAgo += 2 ** 32

      expect(Number(result.secondsAgo)).to.equal(secondsAgo)
    }

    before('create mockObservationsFactory', async () => {
      mockObservationsFactory = await ethers.getContractFactory('MockObservations')
    })

    it('fetches the oldest timestamp from the slot after observationIndex', async () => {
      await runOldestObservationsTest([2, 3, 1, 0], [true, true, true, false], 3, 1)
    })

    it('loops to index 0', async () => {
      await runOldestObservationsTest([1, 2, 3, 0], [true, true, true, false], 3, 2)
    })

    it('fetches from index 0 if next is uninitialized', async () => {
      await runOldestObservationsTest([1, 2, 0, 0], [true, true, false, false], 4, 1)
    })

    it('reverts if the pool is not initialized', async () => {
      const mockObservations = await mockObservationsFactory.deploy(
        [0, 0, 0, 0],
        emptyTickCumulatives,
        emptySPL,
        [false, false, false, false],
        emptyTick,
        0,
        0,
        false,
        emptyLiquidity
      )
      await expect(oracle.getOldestObservationSecondsAgo(mockObservations.target)).to.be.revertedWith('NI')
    })

    it('handles timestamp overflows', async () => {
      const maxUint32 = 2 ** 32 - 1
      await runOldestObservationsTest([maxUint32, 3, maxUint32 - 2, 0], [true, true, true, false], 3, 1)
    })
  })

  describe('#getBlockStartingTickAndLiquidity', () => {
    let mockObservationsFactory: ContractFactory
    let mockObservations: BaseContract
    let blockTimestamps: number[]
    let tickCumulatives: number[]
    let liquidityValues: bigint[] // v6: bigint
    let initializeds: boolean[]
    let slot0Tick: number
    let observationCardinality: number
    let observationIndex: number
    let lastObservationCurrentTimestamp: boolean
    let liquidity: number

    before('create mockObservationsFactory', async () => {
      mockObservationsFactory = await ethers.getContractFactory('MockObservations')
    })

    const deployMockObservationsContract = async () => {
      mockObservations = await mockObservationsFactory.deploy(
        blockTimestamps,
        tickCumulatives,
        liquidityValues,
        initializeds,
        slot0Tick,
        observationCardinality,
        observationIndex,
        lastObservationCurrentTimestamp,
        liquidity
      )
    }

    it('reverts if the pool is not initialized', async () => {
      blockTimestamps = [0, 0, 0, 0]
      tickCumulatives = [0, 0, 0, 0]
      liquidityValues = [BN0, BN0, BN0, BN0]
      initializeds = [false, false, false, false]
      slot0Tick = 0
      observationCardinality = 0
      observationIndex = 0
      lastObservationCurrentTimestamp = false
      liquidity = 0

      await deployMockObservationsContract()
      await expect(oracle.getBlockStartingTickAndLiquidity(mockObservations.target)).to.be.revertedWith('NEO')
    })

    it('returns storage values when latest observation is previous block', async () => {
      blockTimestamps = [1, 3, 4, 0]
      tickCumulatives = [0, 8, 13, 0]
      liquidityValues = [
        0n,
        136112946768375385385349842972707284n,
        184724713471366594451546215462959885n,
        0n,
      ]
      initializeds = [true, true, true, false]
      observationCardinality = 3
      observationIndex = 2
      slot0Tick = 6
      lastObservationCurrentTimestamp = false
      liquidity = 10000

      await deployMockObservationsContract()

      const result = await oracle.getBlockStartingTickAndLiquidity(mockObservations.target)
      expect(result[0]).to.equal(slot0Tick)
      expect(result[1]).to.equal(liquidity)
    })

    it('reverts if 2 observations are needed but missing', async () => {
      blockTimestamps = [1, 0, 0, 0]
      tickCumulatives = [8, 0, 0, 0]
      liquidityValues = [136112946768375385385349842972707284n, 0n, 0n, 0n]
      initializeds = [true, false, false, false]
      observationCardinality = 1
      observationIndex = 0
      slot0Tick = 4
      lastObservationCurrentTimestamp = true
      liquidity = 10000

      await deployMockObservationsContract()
      await expect(oracle.getBlockStartingTickAndLiquidity(mockObservations.target)).to.be.revertedWith('NEO')
    })

    it('reverts if prior observation needed is not initialized', async () => {
      blockTimestamps = [1, 0, 0, 0]
      observationCardinality = 2
      observationIndex = 0
      liquidityValues = [136112946768375385385349842972707284n, 0n, 0n, 0n]
      initializeds = [true, false, false, false]
      tickCumulatives = [8, 0, 0, 0]
      slot0Tick = 4
      lastObservationCurrentTimestamp = true

      await deployMockObservationsContract()
      await expect(oracle.getBlockStartingTickAndLiquidity(mockObservations.target)).to.be.revertedWith('ONI')
    })

    it('calculates prior tick and liquidity from observations', async () => {
      blockTimestamps = [9, 5, 8, 0]
      observationCardinality = 3
      observationIndex = 0
      initializeds = [true, true, true, false]
      tickCumulatives = [99, 80, 95, 0]
      liquidityValues = [
        965320616647837491242414421221086683n,
        839853488995212437053956034406948254n,
        939565063595995342933046073701273770n,
        0n,
      ]
      slot0Tick = 3
      lastObservationCurrentTimestamp = true

      await deployMockObservationsContract()

      const result = await oracle.getBlockStartingTickAndLiquidity(mockObservations.target)
      const actualStartingTick = (tickCumulatives[0] - tickCumulatives[2]) / (blockTimestamps[0] - blockTimestamps[2])
      expect(result[0]).to.equal(actualStartingTick)

      const actualStartingLiquidity = 13212 // per your inline comments
      expect(result[1]).to.equal(actualStartingLiquidity)
    })
  })

  describe('#getWeightedArithmeticMeanTick', () => {
    it('single observation returns average tick', async () => {
      expect(await oracle.getWeightedArithmeticMeanTick([{ tick: 10, weight: 10 }])).to.equal(10)
    })

    it('multiple observations with same weight average across tiers', async () => {
      expect(
        await oracle.getWeightedArithmeticMeanTick([
          { tick: 10, weight: 10 },
          { tick: 20, weight: 10 },
        ])
      ).to.equal(15)
    })

    it('different weights are weighted correctly', async () => {
      expect(
        await oracle.getWeightedArithmeticMeanTick([
          { tick: 10, weight: 10 },
          { tick: 20, weight: 15 },
        ])
      ).to.equal(16)
    })

    it('correct rounding for .5 negative tick', async () => {
      expect(
        await oracle.getWeightedArithmeticMeanTick([
          { tick: -10, weight: 10 },
          { tick: -11, weight: 10 },
        ])
      ).to.equal(-11)
    })
  })

  describe('#getChainedPrice', () => {
    let ticks: number[]

    it('fails with discrepant length', async () => {
      const tokenAddresses = [tokens[0].target, tokens[2].target]
      ticks = [5, 5]
      await expect(oracle.getChainedPrice(tokenAddresses, ticks)).to.be.revertedWith('DL')
    })

    it('add two positive ticks, sorted order', async () => {
      const tokenAddresses = [tokens[0].target, tokens[1].target, tokens[2].target]
      ticks = [5, 5]
      expect(await oracle.getChainedPrice(tokenAddresses, ticks)).to.equal(10)
    })

    it('add one positive and one negative tick, sorted order', async () => {
      const tokenAddresses = [tokens[0].target, tokens[1].target, tokens[2].target]
      ticks = [5, -5]
      expect(await oracle.getChainedPrice(tokenAddresses, ticks)).to.equal(0)
    })

    it('add one negative and one positive tick, sorted order', async () => {
      const tokenAddresses = [tokens[0].target, tokens[1].target, tokens[2].target]
      ticks = [-5, 5]
      expect(await oracle.getChainedPrice(tokenAddresses, ticks)).to.equal(0)
    })

    it('add two negative ticks, sorted order', async () => {
      const tokenAddresses = [tokens[0].target, tokens[1].target, tokens[2].target]
      ticks = [-5, -5]
      expect(await oracle.getChainedPrice(tokenAddresses, ticks)).to.equal(-10)
    })

    it('add two positive ticks, token0/token1 + token1/token0', async () => {
      const tokenAddresses = [tokens[0].target, tokens[2].target, tokens[1].target]
      ticks = [5, 5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(0)
    })
    it('add one positive tick and one negative tick, token0/token1 + token1/token0', async () => {
      const tokenAddresses = [tokens[0].target, tokens[2].target, tokens[1].target]
      ticks = [5, -5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(10)
    })
    it('add one negative tick and one positive tick, token0/token1 + token1/token0', async () => {
      const tokenAddresses = [tokens[0].target, tokens[2].target, tokens[1].target]
      ticks = [-5, 5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(-10)
    })
    it('add two negative ticks, token0/token1 + token1/token0', async () => {
      const tokenAddresses = [tokens[0].target, tokens[2].target, tokens[1].target]
      ticks = [-5, -5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(0)
    })

    it('add two positive ticks, token1/token0 + token0/token1', async () => {
      const tokenAddresses = [tokens[1].target, tokens[0].target, tokens[2].target]
      ticks = [5, 5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(0)
    })
    it('add one positive tick and one negative tick, token1/token0 + token0/token1', async () => {
      const tokenAddresses = [tokens[1].target, tokens[0].target, tokens[2].target]
      ticks = [5, -5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(-10)
    })
    it('add one negative tick and one positive tick, token1/token0 + token0/token1', async () => {
      const tokenAddresses = [tokens[1].target, tokens[0].target, tokens[2].target]
      ticks = [-5, 5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(10)
    })
    it('add two negative ticks, token1/token0 + token0/token1', async () => {
      const tokenAddresses = [tokens[1].target, tokens[0].target, tokens[2].target]
      ticks = [-5, -5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(0)
    })

    it('add two positive ticks, token0/token1 + token1/token0', async () => {
      const tokenAddresses = [tokens[1].target, tokens[2].target, tokens[0].target]
      ticks = [5, 5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(0)
    })
    it('add one positive tick and one negative tick, token0/token1 + token1/token0', async () => {
      const tokenAddresses = [tokens[1].target, tokens[2].target, tokens[0].target]
      ticks = [5, -5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(10)
    })
    it('add one negative tick and one positive tick, token0/token1 + token1/token0', async () => {
      const tokenAddresses = [tokens[1].target, tokens[2].target, tokens[0].target]
      ticks = [-5, 5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(-10)
    })
    it('add two negative ticks, token0/token1 + token1/token0', async () => {
      const tokenAddresses = [tokens[1].target, tokens[2].target, tokens[0].target]
      ticks = [-5, -5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(0)
    })

    it('add two positive ticks, token1/token0 + token0/token1', async () => {
      const tokenAddresses = [tokens[2].target, tokens[0].target, tokens[1].target]
      ticks = [5, 5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(0)
    })
    it('add one positive tick and one negative tick, token1/token0 + token0/token1', async () => {
      const tokenAddresses = [tokens[2].target, tokens[0].target, tokens[1].target]
      ticks = [5, -5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(-10)
    })
    it('add one negative tick and one positive tick, token1/token0 + token0/token1', async () => {
      const tokenAddresses = [tokens[2].target, tokens[0].target, tokens[1].target]
      ticks = [-5, 5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(10)
    })
    it('add two negative ticks, token1/token0 + token0/token1', async () => {
      const tokenAddresses = [tokens[2].target, tokens[0].target, tokens[1].target]
      ticks = [-5, -5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(0)
    })

    it('add two positive ticks, token1/token0 + token1/token0', async () => {
      const tokenAddresses = [tokens[2].target, tokens[1].target, tokens[0].target]
      ticks = [5, 5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(-10)
    })
    it('add one positive tick and one negative tick, token1/token0 + token1/token0', async () => {
      const tokenAddresses = [tokens[2].target, tokens[1].target, tokens[0].target]
      ticks = [5, -5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(0)
    })
    it('add one negative tick and one positive tick, token1/token0 + token1/token0', async () => {
      const tokenAddresses = [tokens[2].target, tokens[1].target, tokens[0].target]
      ticks = [-5, 5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(0)
    })
    it('add two negative ticks, token1/token0 + token1/token0', async () => {
      const tokenAddresses = [tokens[2].target, tokens[1].target, tokens[0].target]
      ticks = [-5, -5]
      const oracleTick = await oracle.getChainedPrice(tokenAddresses, ticks)

      expect(oracleTick).to.equal(10)
    })
  })
})
