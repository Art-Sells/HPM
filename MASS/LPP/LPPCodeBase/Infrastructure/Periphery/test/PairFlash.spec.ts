// test/PairFlash.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { expect } from './shared/expect.ts'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'

import type { PairFlash, TestERC20, SupplicateQuoter } from '../typechain-types/periphery'
import type { ILPPFactory } from '../typechain-types/protocol'

import completeFixture from './shared/completeFixture.ts'
import { FeeAmount } from './shared/constants.ts'
import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'
import { computePoolAddress } from './shared/computePoolAddress.ts'

// helper: safe JS number
const n = (x: bigint | number) => Number(x)

describe('PairFlash (ZERO fee only)', () => {
  let wallet: any
  let flash: PairFlash
  let token0: TestERC20
  let token1: TestERC20
  let factory: ILPPFactory
  let quoter: SupplicateQuoter

  async function fixture() {
    const signers = await ethers.getSigners()
    wallet = signers[0]

    // completeFixture returns { router, tokens, factory, weth9, ... }
    const { router, tokens, factory, weth9 } = await completeFixture(signers, ethers.provider)
    const [t0, t1] = tokens as TestERC20[] // tokens array may have 3; we only need the first two

    const flashFactory = await ethers.getContractFactory('PairFlash')
    const flash = (await flashFactory.deploy(
      router.target,   // address of router
      factory.target,  // address of core factory
      weth9.target     // address of WETH9
    )) as unknown as PairFlash
    await flash.waitForDeployment()

    const quoterFactory = await ethers.getContractFactory('SupplicateQuoter')
    const quoter = (await quoterFactory.deploy(
      factory.target,
      weth9.target
    )) as unknown as SupplicateQuoter
    await quoter.waitForDeployment()

    return { token0: t0, token1: t1, flash, factory, quoter, router }
  }

  beforeEach(async () => {
    ({ factory, token0, token1, flash, quoter } = await loadFixture(fixture))
  })

  describe('flash', () => {
    it('emits correct transfers (ZERO fee)', async () => {
      const amount0In = 1_000
      const amount1In = 1_000
      const fee0 = 0
      const fee1 = 0

      // If your PairFlash.initFlash expects a single `fee`, keep only that.
      const flashParams = {
        token0: token0.target,
        token1: token1.target,
        fee:    FeeAmount.ZERO,
        amount0: amount0In,
        amount1: amount1In,
      } as any

      // single ZERO-fee pool
      const pool = computePoolAddress(
        String(factory.target),
        [String(token0.target), String(token1.target)],
        FeeAmount.ZERO
      )

      // quotes under ZERO fee (ethers v6: .staticCall)
      const expectedAmountOut0 = await quoter.quoteExactInputSingle.staticCall(
        token1.target,
        token0.target,
        FeeAmount.ZERO,
        amount1In,
        encodePriceSqrt(20, 10)
      )
      const expectedAmountOut1 = await quoter.quoteExactInputSingle.staticCall(
        token0.target,
        token1.target,
        FeeAmount.ZERO,
        amount0In,
        encodePriceSqrt(5, 10)
      )

      const walletAddr = await wallet.getAddress()

      await expect(flash.initFlash(flashParams))
        // borrow transfers from ZERO-fee pool to flash
        .to.emit(token0, 'Transfer').withArgs(pool,  flash.target, amount0In)
        .to.emit(token1, 'Transfer').withArgs(pool,  flash.target, amount1In)
        // swap proceeds back to flash
        .to.emit(token0, 'Transfer').withArgs(pool,  flash.target, expectedAmountOut0)
        .to.emit(token1, 'Transfer').withArgs(pool,  flash.target, expectedAmountOut1)
        // flash keeps profit (no fee charged)
        .to.emit(token0, 'Transfer').withArgs(flash.target, walletAddr, n(expectedAmountOut0) - amount0In - fee0)
        .to.emit(token1, 'Transfer').withArgs(flash.target, walletAddr, n(expectedAmountOut1) - amount1In - fee1)
    })

    it('gas (ZERO fee)', async () => {
      const flashParams = {
        token0: token0.target,
        token1: token1.target,
        fee:    FeeAmount.ZERO,
        amount0: 1_000,
        amount1: 1_000,
      } as any
      await snapshotGasCost(flash.initFlash(flashParams))
    })
  })
})