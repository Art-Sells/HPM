// test/TickLens.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { MaxUint256 } from 'ethers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'

import type {
  MockTimeNonfungiblePositionManager,
  TestERC20,
  TickLensTest,
} from '../typechain-types/periphery'

import completeFixture from './shared/completeFixture.ts'
import { FeeAmount } from './shared/constants.ts'
import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'
import { expect } from './shared/expect.ts'
import { getMaxTick, getMinTick } from './shared/ticks.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'

// ZERO FEES ONLY
const FEE = FeeAmount.ZERO

describe('TickLens (ZERO fee tier)', function () {
  this.timeout(120_000)

  let wallet: HardhatEthersSigner
  let wallets: HardhatEthersSigner[]

  async function fixture() {
    wallets = (await ethers.getSigners()) as HardhatEthersSigner[]
    wallet = wallets[0]

    const provider = ethers.provider
    const { factory, tokens, nft } = await completeFixture(wallets as any, provider)

    // approvals for NFT manager
    const nftAddr = await nft.getAddress()
    for (const t of tokens) {
      await (await t.approve(nftAddr, MaxUint256)).wait()
    }

    // deploy the lens tester
    const LensFactory = await ethers.getContractFactory('TickLensTest')
    const tickLens = (await LensFactory.deploy()) as unknown as TickLensTest
    await tickLens.waitForDeployment()

    return { factory, tokens, nft, tickLens }
  }

  let nft: MockTimeNonfungiblePositionManager
  let tokens: [TestERC20, TestERC20, TestERC20]
  let tickLens: TickLensTest
  let poolAddress: string

  const sort = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a])

  // spacing directly from pool (authoritative)
  async function poolSpacing(pool: string): Promise<number> {
    const poolIface = await ethers.getContractAt('ILPPPool', pool)
    const s: bigint = await (poolIface as any).tickSpacing()
    return Number(s)
  }

  // derive TickBitmap word index from the pool’s tickSpacing (Solidity semantics)
  async function wordIndexForTick(pool: string, tick: number) {
    const spacing = BigInt(await poolSpacing(pool))
    const compressed = BigInt(tick) / spacing // trunc toward 0
    // i = compressed < 0 ? ((compressed + 1) >> 8) - 1 : compressed >> 8
    if (compressed < 0n) {
      return Number(((compressed + 1n) >> 8n) - 1n)
    } else {
      return Number(compressed >> 8n)
    }
  }

  // scan up to ±64 words to find the one that actually contains targetTick
  async function findWordContainingTick(pool: string, baseIdx: number, targetTick: number) {
    // check base first
    let ticks = await tickLens.getPopulatedTicksInWord(pool, baseIdx)
    if (ticks.find((t) => Number(t.tick) === targetTick)) {
      return { idx: baseIdx, ticks }
    }

    for (let d = 1; d <= 64; d++) {
      const leftIdx = baseIdx - d
      const rightIdx = baseIdx + d

      // left
      ticks = await tickLens.getPopulatedTicksInWord(pool, leftIdx)
      if (ticks.find((t) => Number(t.tick) === targetTick)) {
        return { idx: leftIdx, ticks }
      }

      // right
      ticks = await tickLens.getPopulatedTicksInWord(pool, rightIdx)
      if (ticks.find((t) => Number(t.tick) === targetTick)) {
        return { idx: rightIdx, ticks }
      }
    }

    // not found — small neighbor dump for debugging
    const around: Array<{ idx: number; size: number; sample?: number[] }> = []
    for (let d = 0; d <= 4; d++) {
      for (const s of [-1, 1]) {
        const i = baseIdx + d * s
        const w = await tickLens.getPopulatedTicksInWord(pool, i)
        around.push({ idx: i, size: w.length, sample: w.slice(0, 3).map((x) => Number(x.tick)) })
      }
    }
    throw new Error(
      `Could not find tick ${targetTick} near word ${baseIdx}. Neighbors: ${around
        .map((x) => `[${x.idx}: len=${x.size}${x.sample && x.sample.length ? ` sample=${x.sample.join(',')}` : ''}]`)
        .join(' ')}`
    )
  }

  // mint and also get returned liquidity using ethers v6 `staticCall`
  async function mintAndReturnLiquidity(params: any): Promise<bigint> {
    const fn = nft.getFunction('mint')
    const staticResult: { tokenId: bigint; liquidity: bigint; amount0: bigint; amount1: bigint } =
      await (fn as any).staticCall(params)
    await (await nft.mint(params)).wait()
    return staticResult.liquidity
  }

  // create pool (read its address via staticCall) + full-range LP using the POOL'S spacing
  async function createFullRangePoolAndGetAddress(tokenA: string, tokenB: string) {
    const [token0, token1] = sort(tokenA, tokenB)
    const sqrt = encodePriceSqrt(1, 1)

    // 1) read the pool address that WILL be used
    const staticPoolAddr: string = await (nft.getFunction('createAndInitializePoolIfNecessary') as any).staticCall(
      token0,
      token1,
      FEE,
      sqrt
    )
    // 2) actually create/init the pool
    await (await nft.createAndInitializePoolIfNecessary(token0, token1, FEE, sqrt)).wait()

    // 3) use the pool’s real spacing for the full-range position
    const spacing = await poolSpacing(staticPoolAddr)
    const mintParams = {
      token0,
      token1,
      fee: FEE,
      tickLower: getMinTick(spacing),
      tickUpper: getMaxTick(spacing),
      recipient: await wallet.getAddress(),
      amount0Desired: 1_000_000,
      amount1Desired: 1_000_000,
      amount0Min: 0,
      amount1Min: 0,
      deadline: 1,
    }
    await mintAndReturnLiquidity(mintParams)

    return staticPoolAddr
  }

  beforeEach('load fixture and create pool', async () => {
    const f = await loadFixture(fixture)
    nft = f.nft
    tokens = f.tokens
    tickLens = f.tickLens

    const t0 = await tokens[0].getAddress()
    const t1 = await tokens[1].getAddress()
    const [a, b] = sort(t0, t1)

    poolAddress = await createFullRangePoolAndGetAddress(a, b)
  })

  describe('#getPopulatedTicksInWord (zero fee)', () => {
    it('works for min/max', async () => {
      const spacing = await poolSpacing(poolAddress)
      const minTick = getMinTick(spacing)
      const maxTick = getMaxTick(spacing)

      const baseMin = await wordIndexForTick(poolAddress, minTick)
      const baseMax = await wordIndexForTick(poolAddress, maxTick)

      const { ticks: minWord } = await findWordContainingTick(poolAddress, baseMin, minTick)
      const { ticks: maxWord } = await findWordContainingTick(poolAddress, baseMax, maxTick)

      expect(minWord.length, 'min word empty').to.be.greaterThan(0)
      expect(maxWord.length, 'max word empty').to.be.greaterThan(0)

      const minEntry = minWord.find((t) => Number(t.tick) === minTick)!
      const maxEntry = maxWord.find((t) => Number(t.tick) === maxTick)!

      // exact full-range L (static, using pool spacing)
      const [token0, token1] = sort(await tokens[0].getAddress(), await tokens[1].getAddress())
      const { liquidity: fullRangeLiquidity } = await (nft.getFunction('mint') as any).staticCall({
        token0,
        token1,
        fee: FEE,
        tickLower: minTick,
        tickUpper: maxTick,
        recipient: await wallet.getAddress(),
        amount0Desired: 1_000_000,
        amount1Desired: 1_000_000,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })

      expect(BigInt(minEntry.liquidityNet)).to.eq(fullRangeLiquidity as bigint)
      expect(BigInt(minEntry.liquidityGross)).to.eq(fullRangeLiquidity as bigint)
      expect(BigInt(maxEntry.liquidityNet)).to.eq(-(fullRangeLiquidity as bigint))
      expect(BigInt(maxEntry.liquidityGross)).to.eq(fullRangeLiquidity as bigint)
    })

    it('works for min/max and -2/-1/0/1', async () => {
      const spacing = await poolSpacing(poolAddress)
      const [token0, token1] = sort(await tokens[0].getAddress(), await tokens[1].getAddress())

      const minus = -spacing
      const plus = spacing

      const mintRange = async (tickLower: number, tickUpper: number, amt: number) => {
        return mintAndReturnLiquidity({
          token0,
          token1,
          fee: FEE,
          tickLower,
          tickUpper,
          recipient: await wallet.getAddress(),
          amount0Desired: amt,
          amount1Desired: amt,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        })
      }

      const L0 = await mintRange(minus * 2, minus, 2)  // (-2, -1]
      const L1 = await mintRange(minus * 2, 0, 3)      // (-2, 0]
      const L2 = await mintRange(minus * 2, plus, 5)   // (-2, +1]
      const L3 = await mintRange(minus, 0, 7)          // (-1, 0]
      const L4 = await mintRange(minus, plus, 11)      // (-1, +1]
      const L5 = await mintRange(0, plus, 13)          // (0, +1]

      const minTick = getMinTick(spacing)
      const maxTick = getMaxTick(spacing)

      const [baseMin, baseNeg, basePos, baseMax] = await Promise.all([
        wordIndexForTick(poolAddress, minTick),
        wordIndexForTick(poolAddress, minus),
        wordIndexForTick(poolAddress, plus),
        wordIndexForTick(poolAddress, maxTick),
      ])

      const { ticks: wMin } = await findWordContainingTick(poolAddress, baseMin, minTick)
      const { ticks: wNeg } = await findWordContainingTick(poolAddress, baseNeg, minus)
      const { ticks: wPos } = await findWordContainingTick(poolAddress, basePos, plus)
      const { ticks: wMax } = await findWordContainingTick(poolAddress, baseMax, maxTick)

      for (const arr of [wMin, wNeg, wPos, wMax]) expect(arr.length).to.be.greaterThan(0)

      const entryMin  = wMin.find((t) => Number(t.tick) === minTick)!
      const entryMax  = wMax.find((t) => Number(t.tick) === maxTick)!
      const entryNeg2 = wNeg.find((t) => Number(t.tick) === minus * 2)!
      const entryNeg1 = wNeg.find((t) => Number(t.tick) === minus)!
      const entryZero = wPos.find((t) => Number(t.tick) === 0)!
      const entryPos1 = wPos.find((t) => Number(t.tick) === plus)!

      const { liquidity: fullRangeLiquidity } = await (nft.getFunction('mint') as any).staticCall({
        token0,
        token1,
        fee: FEE,
        tickLower: minTick,
        tickUpper: maxTick,
        recipient: await wallet.getAddress(),
        amount0Desired: 1_000_000,
        amount1Desired: 1_000_000,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })

      expect(BigInt(entryMin.liquidityNet)).to.eq(fullRangeLiquidity as bigint)
      expect(BigInt(entryMin.liquidityGross)).to.eq(fullRangeLiquidity as bigint)
      expect(BigInt(entryMax.liquidityNet)).to.eq(-(fullRangeLiquidity as bigint))
      expect(BigInt(entryMax.liquidityGross)).to.eq(fullRangeLiquidity as bigint)

      // -2
      expect(BigInt(entryNeg2.liquidityNet)).to.eq(L0 + L1 + L2)
      expect(BigInt(entryNeg2.liquidityGross)).to.eq(L0 + L1 + L2)

      // -1
      expect(BigInt(entryNeg1.liquidityNet)).to.eq(L3 + L4 - L0)
      expect(BigInt(entryNeg1.liquidityGross)).to.eq(L3 + L4 + L0)

      // 0
      expect(BigInt(entryZero.liquidityNet)).to.eq(L5 - L1 - L3)
      expect(BigInt(entryZero.liquidityGross)).to.eq(L5 + L1 + L3)

      // +1
      expect(BigInt(entryPos1.liquidityNet)).to.eq(-(L2 + L4 + L5))
      expect(BigInt(entryPos1.liquidityGross)).to.eq(L2 + L4 + L5)
    })

    it('gas for single populated tick', async () => {
      const spacing = await poolSpacing(poolAddress)
      const maxTick = getMaxTick(spacing)
      const idx = await wordIndexForTick(poolAddress, maxTick)
      await snapshotGasCost(tickLens.getGasCostOfGetPopulatedTicksInWord(poolAddress, idx))
    })

    it('fully populated ticks', async () => {
      // fully populate the word that contains tick 0 using the POOL’S spacing
      const spacing = await poolSpacing(poolAddress)
      const [token0, token1] = sort(await tokens[0].getAddress(), await tokens[1].getAddress())

      for (let i = 0; i < 128; i++) {
        const lower = i * spacing
        const upper = (255 - i) * spacing
        await mintAndReturnLiquidity({
          token0,
          token1,
          fee: FEE,
          tickLower: lower,
          tickUpper: upper,
          recipient: await wallet.getAddress(),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        })
      }

      const base0 = await wordIndexForTick(poolAddress, 0)
      const { idx: idx0, ticks } = await findWordContainingTick(poolAddress, base0, 0)

      expect(ticks.length).to.eq(256)

      await snapshotGasCost(tickLens.getGasCostOfGetPopulatedTicksInWord(poolAddress, idx0))
    }).timeout(300_000)
  })
})