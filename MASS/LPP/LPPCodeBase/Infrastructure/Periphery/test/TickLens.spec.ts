// test/TickLens.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { MaxUint256 } from 'ethers'

import completeFixture from './shared/completeFixture.ts'
import { FeeAmount, TICK_SPACINGS } from './shared/constants.ts'
import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'
import { expect } from './shared/expect.ts'
import { getMaxTick, getMinTick } from './shared/ticks.ts'
import { computePoolAddress } from './shared/computePoolAddress.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'

import type {
  MockTimeNonfungiblePositionManager,
  TestERC20,
  TickLensTest,
} from '../typechain-types/periphery'
import type { ILPPFactory } from '../typechain-types/protocol'

describe('TickLens', () => {
  // Use ZERO fee tier to match the rest of your suite
  const FEE = FeeAmount.ZERO
  const fullRangeLiquidity = 1_000_000

  let owner: HardhatEthersSigner

  async function nftFixture() {
    const signers = await ethers.getSigners()
    owner = signers[0] as HardhatEthersSigner
    const provider = ethers.provider

    const { factory, tokens, nft } = await completeFixture(signers as any, provider)

    const nftAddr = await nft.getAddress()
    for (const token of tokens) {
      await (await token.approve(nftAddr, MaxUint256)).wait()
    }

    return { factory, nft, tokens }
  }

  let factory: ILPPFactory
  let nft: MockTimeNonfungiblePositionManager
  let tokens: [TestERC20, TestERC20, TestERC20]
  let poolAddress: string
  let tickLens: TickLensTest

  // -------- helpers --------

  async function createPool(tokenAddressA: string, tokenAddressB: string) {
    let a = tokenAddressA
    let b = tokenAddressB
    if (a.toLowerCase() > b.toLowerCase()) [a, b] = [b, a]

    // init at 1:1
    const tx1 = await nft.createAndInitializePoolIfNecessary(a, b, FEE, encodePriceSqrt(1, 1))
    await tx1.wait()

    const spacing = TICK_SPACINGS[FEE]
    const recipient = await owner.getAddress()

    const tx2 = await nft.mint({
      token0: a,
      token1: b,
      fee: FEE,
      tickLower: getMinTick(spacing),
      tickUpper: getMaxTick(spacing),
      recipient,
      amount0Desired: fullRangeLiquidity,
      amount1Desired: fullRangeLiquidity,
      amount0Min: 0,
      amount1Min: 0,
      deadline: 1,
    })
    await tx2.wait()
  }

  // ethers v6 replacement for callStatic: use .staticCall on the function
  async function mint(tickLower: number, tickUpper: number, amountBothDesired: bigint | number): Promise<number> {
    const [t0, t1] = await Promise.all([tokens[0].getAddress(), tokens[1].getAddress()])
    const recipient = await owner.getAddress()

    const params = {
      token0: t0,
      token1: t1,
      fee: FEE,
      tickLower,
      tickUpper,
      amount0Desired: amountBothDesired,
      amount1Desired: amountBothDesired,
      amount0Min: 0,
      amount1Min: 0,
      recipient,
      deadline: 1,
    } as const

    const res = await nft.mint.staticCall(params) // <- replaces nft.callStatic.mint(...)
    const liquidity = Number(res.liquidity)

    await (await nft.mint(params)).wait()
    return liquidity
  }

  // BigInt-based version of the old BigNumber helper
  function getTickBitmapIndex(tick: number, tickSpacing: number): number {
    const t = BigInt(tick)
    const s = BigInt(tickSpacing)
    const q = t / s // rounds toward 0 like Solidity
    const word = q < 0n ? (q + 1n) / (1n << 8n) - 1n : q >> 8n
    return Number(word)
  }

  // -------- lifecycle --------

  beforeEach('load fixture', async () => {
    ;({ factory, tokens, nft } = await loadFixture(nftFixture))
  })

  beforeEach('create pool & lens', async () => {
    const [t0, t1, faddr] = await Promise.all([
      tokens[0].getAddress(),
      tokens[1].getAddress(),
      factory.getAddress(),
    ])

    await createPool(t0, t1)
    poolAddress = computePoolAddress(faddr, [t0, t1], FEE)

    const LensFactory = await ethers.getContractFactory('TickLensTest')
    const deployed = await LensFactory.deploy()
    await deployed.waitForDeployment()
    tickLens = deployed as unknown as TickLensTest // cast via unknown to satisfy TS
  })

  // -------- tests --------

  describe('#getPopulatedTicksInWord', () => {
    it('works for min/max', async () => {
      const spacing = TICK_SPACINGS[FEE]

      const [min] = await tickLens.getPopulatedTicksInWord(
        poolAddress,
        getTickBitmapIndex(getMinTick(spacing), spacing)
      )

      const [max] = await tickLens.getPopulatedTicksInWord(
        poolAddress,
        getTickBitmapIndex(getMaxTick(spacing), spacing)
      )

      expect(min.tick).to.eq(getMinTick(spacing))
      expect(min.liquidityNet).to.eq(fullRangeLiquidity)
      expect(min.liquidityGross).to.eq(fullRangeLiquidity)

      expect(max.tick).to.eq(getMaxTick(spacing))
      expect(max.liquidityNet).to.eq(fullRangeLiquidity * -1)
      expect(max.liquidityGross).to.eq(fullRangeLiquidity)
    })

    it('works for min/max and -2/-1/0/1', async () => {
      const spacing = TICK_SPACINGS[FEE]
      const minus = -spacing
      const plus = spacing

      const l0 = await mint(minus * 2, minus, 2)
      const l1 = await mint(minus * 2, 0, 3)
      const l2 = await mint(minus * 2, plus, 5)
      const l3 = await mint(minus, 0, 7)
      const l4 = await mint(minus, plus, 11)
      const l5 = await mint(0, plus, 13)

      const [min] = await tickLens.getPopulatedTicksInWord(
        poolAddress,
        getTickBitmapIndex(getMinTick(spacing), spacing)
      )

      const [negOne, negTwo] = await tickLens.getPopulatedTicksInWord(
        poolAddress,
        getTickBitmapIndex(minus, spacing)
      )

      const [one, zero] = await tickLens.getPopulatedTicksInWord(
        poolAddress,
        getTickBitmapIndex(plus, spacing)
      )

      const [max] = await tickLens.getPopulatedTicksInWord(
        poolAddress,
        getTickBitmapIndex(getMaxTick(spacing), spacing)
      )

      expect(min.tick).to.eq(getMinTick(spacing))
      expect(min.liquidityNet).to.eq(fullRangeLiquidity)
      expect(min.liquidityGross).to.eq(fullRangeLiquidity)

      expect(negTwo.tick).to.eq(minus * 2)
      expect(negTwo.liquidityNet).to.eq(l0 + l1 + l2)
      expect(negTwo.liquidityGross).to.eq(l0 + l1 + l2)

      expect(negOne.tick).to.eq(minus)
      expect(negOne.liquidityNet).to.eq(l3 + l4 - l0)
      expect(negOne.liquidityGross).to.eq(l3 + l4 + l0)

      expect(zero.tick).to.eq(0)
      expect(zero.liquidityNet).to.eq(l5 - l1 - l3)
      expect(zero.liquidityGross).to.eq(l5 + l1 + l3)

      expect(one.tick).to.eq(plus)
      expect(one.liquidityNet).to.eq(-l2 - l4 - l5)
      expect(one.liquidityGross).to.eq(l2 + l4 + l5)

      expect(max.tick).to.eq(getMaxTick(spacing))
      expect(max.liquidityNet).to.eq(fullRangeLiquidity * -1)
      expect(max.liquidityGross).to.eq(fullRangeLiquidity)
    })

    it('gas for single populated tick', async () => {
      const spacing = TICK_SPACINGS[FEE]
      await snapshotGasCost(
        tickLens.getGasCostOfGetPopulatedTicksInWord(
          poolAddress,
          getTickBitmapIndex(getMaxTick(spacing), spacing)
        )
      )
    })

    it('fully populated ticks', async () => {
      const spacing = TICK_SPACINGS[FEE]

      // fully populate a word
      for (let i = 0; i < 128; i++) {
        await mint(i * spacing, (255 - i) * spacing, 100)
      }

      const ticks = await tickLens.getPopulatedTicksInWord(
        poolAddress,
        getTickBitmapIndex(0, spacing)
      )
      expect(ticks.length).to.eq(256)

      await snapshotGasCost(
        tickLens.getGasCostOfGetPopulatedTicksInWord(
          poolAddress,
          getTickBitmapIndex(0, spacing)
        )
      )
    }).timeout(300_000)
  })
})