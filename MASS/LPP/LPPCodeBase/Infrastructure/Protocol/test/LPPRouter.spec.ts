// test/LPPPool.multi-supplications.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'

import type {
  TestERC20,
  LPPFactory,
  MockTimeLPPPool,
  TestLPPRouter,
  TestLPPCallee,
} from '../typechain-types/protocol'

import { expect } from './shared/expect.ts'
import { poolFixture } from './shared/fixtures.ts'

import {
  FeeAmount,
  TICK_SPACINGS,
  createPoolFunctions,
  type PoolFunctions,
  createMultiPoolFunctions,
  encodePriceSqrt,
  getMinTick,
  getMaxTick,
  expandTo18Decimals,
} from './shared/utilities.ts'

const feeAmount = FeeAmount.ZERO
const tickSpacing = TICK_SPACINGS[feeAmount]

type ThenArg<T> = T extends PromiseLike<infer U> ? U : T

describe('LPPPool', () => {
  let wallet: HardhatEthersSigner, other: HardhatEthersSigner

  let token0: TestERC20
  let token1: TestERC20
  let token2: TestERC20
  let factory: LPPFactory
  let pool0: MockTimeLPPPool
  let pool1: MockTimeLPPPool

  let pool0Functions: PoolFunctions
  let pool1Functions: PoolFunctions

  let minTick: number
  let maxTick: number

  let swapTargetCallee: TestLPPCallee
  let swapTargetRouter: TestLPPRouter

  let createPool: ThenArg<ReturnType<typeof poolFixture>>['createPool']

  before(async () => {
    ;[wallet, other] = (await ethers.getSigners()) as unknown as [
      HardhatEthersSigner,
      HardhatEthersSigner
    ]
  })

  beforeEach('deploy first fixture', async () => {
    ;({ token0, token1, token2, factory, createPool, swapTargetCallee, swapTargetRouter } =
      await loadFixture(poolFixture))

    const createPoolWrapped = async (
      amount: number,
      spacing: number,
      firstToken: TestERC20,
      secondToken: TestERC20
    ): Promise<[MockTimeLPPPool, PoolFunctions]> => {
      const pool = await createPool(amount, spacing, firstToken, secondToken)
      const poolFunctions = createPoolFunctions({
        swapTarget: swapTargetCallee,
        token0: firstToken,
        token1: secondToken,
        pool,
      })
      minTick = getMinTick(spacing)
      maxTick = getMaxTick(spacing)
      return [pool, poolFunctions]
    }

    // default to the ZERO-fee pool
    ;[pool0, pool0Functions] = await createPoolWrapped(feeAmount, tickSpacing, token0, token1)
    ;[pool1, pool1Functions] = await createPoolWrapped(feeAmount, tickSpacing, token1, token2)
  })

  it('constructor initializes immutables', async () => {
    expect(await pool0.factory()).to.eq(await factory.getAddress())
    expect(await pool0.token0()).to.eq(await token0.getAddress())
    expect(await pool0.token1()).to.eq(await token1.getAddress())

    expect(await pool1.factory()).to.eq(await factory.getAddress())
    expect(await pool1.token0()).to.eq(await token1.getAddress())
    expect(await pool1.token1()).to.eq(await token2.getAddress())
  })

  describe('multi-supplications', () => {
    let inputToken: TestERC20
    let outputToken: TestERC20

    beforeEach('initialize both pools', async () => {
      inputToken = token0
      outputToken = token2

      await pool0.initialize(encodePriceSqrt(1, 1))
      await pool1.initialize(encodePriceSqrt(1, 1))

      await pool0Functions.mint(wallet.address, minTick, maxTick, expandTo18Decimals(1))
      await pool1Functions.mint(wallet.address, minTick, maxTick, expandTo18Decimals(1))
    })

    it('multi-supplicate', async () => {
      const token0OfPoolOutput = await pool1.token0()
      const outputTokenAddr = await outputToken.getAddress()
      const forExact0 = outputTokenAddr === token0OfPoolOutput

      // Alias the "swap" helpers to "supplicate" names for this test file
      const {
        swapForExact0Multi: supplicateForExact0Multi,
        swapForExact1Multi: supplicateForExact1Multi,
      } = createMultiPoolFunctions({
        inputToken: token0,
        swapTarget: swapTargetRouter,
        poolInput: pool0,
        poolOutput: pool1,
      })

      const method = forExact0 ? supplicateForExact0Multi : supplicateForExact1Multi


      const pool0Addr = await pool0.getAddress()
      const pool1Addr = await pool1.getAddress()
      await expect(method(100, wallet.address))
        .to.emit(outputToken, 'Transfer')
        .withArgs(pool1Addr, wallet.address, 100)
        .to.emit(token1, 'Transfer')
        .withArgs(pool0Addr, pool1Addr, 101) 
        .to.emit(inputToken, 'Transfer')
        .withArgs(wallet.address, pool0Addr, 102)
    })
  })
})