// test/PairFlash.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { expect } from './shared/expect.ts'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'

import type { PairFlash, TestERC20 } from '../typechain-types/periphery'
import type { ILPPFactory, ILPPPool } from '../typechain-types/protocol'

import completeFixture from './shared/completeFixture.ts'
import { FeeAmount } from './shared/constants.ts'
import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'

// --- helpers ----------------------------------------------------------------

async function ensureZeroFeePoolWithLiquidity(
  factory: ILPPFactory,
  tokenA: TestERC20,
  tokenB: TestERC20,
  npm: any,              // MockTimeNonfungiblePositionManager
  payerAddr: string
) {
  // sort to (token0, token1) for pool key
  const a = String(tokenA.target).toLowerCase()
  const b = String(tokenB.target).toLowerCase()
  const [t0, t1] = a < b ? [tokenA, tokenB] : [tokenB, tokenA]
  const token0 = String(t0.target)
  const token1 = String(t1.target)

  // enable 0-fee tier if needed (idempotent)
  if ((await factory.feeAmountTickSpacing(FeeAmount.ZERO)) === 0n) {
    await (await factory.enableFeeAmount(FeeAmount.ZERO, 60)).wait()
  }

  // create+init via NPM helper (idempotent behavior)
  await (await npm.createAndInitializePoolIfNecessary(
    token0,
    token1,
    FeeAmount.ZERO,
    encodePriceSqrt(1, 1) // ~1:1 start price
  )).wait()

  const poolAddr = await factory.getPool(token0, token1, FeeAmount.ZERO)
  const pool = (await ethers.getContractAt('ILPPPool', poolAddr)) as unknown as ILPPPool

  // approvals FROM payer to NPM
  const signer = await ethers.getSigner(payerAddr)
  await (await t0.connect(signer).approve(npm.target, ethers.MaxUint256)).wait()
  await (await t1.connect(signer).approve(npm.target, ethers.MaxUint256)).wait()

  // centered range around current price
  const spacing = Number(await pool.tickSpacing())
  const tickLower = -spacing * 10
  const tickUpper =  spacing * 10

  // mint a tiny bit of liquidity
  const amountDesired = 1_000_000n
  await (await npm.connect(signer).mint({
    token0, token1,
    fee: FeeAmount.ZERO,
    tickLower, tickUpper,
    amount0Desired: amountDesired,
    amount1Desired: amountDesired,
    amount0Min: 0,
    amount1Min: 0,
    recipient: payerAddr,
    deadline: (await time.latest()) + 3600,
  })).wait()

  return { poolAddr, pool, token0, token1, t0, t1 }
}

// --- tests ------------------------------------------------------------------

describe('PairFlash (ZERO fee only)', () => {
  let wallet: any
  let flash: PairFlash
  let token0: TestERC20
  let token1: TestERC20
  let factory: ILPPFactory
  let pool: ILPPPool

  async function fixture() {
    const signers = await ethers.getSigners()
    wallet = signers[0]

    // completeFixture returns { router, tokens, factory, weth9, nft, ... }
    const base: any = await completeFixture(signers, ethers.provider)
    const { router, tokens, factory, weth9 } = base
    const npm = base.nft ?? base.nonfungiblePositionManager

    const [tA, tB] = tokens as TestERC20[]
    const payer = await wallet.getAddress()

    // seed zero-fee pool with a sliver of liquidity
    const seeded = await ensureZeroFeePoolWithLiquidity(
      factory as unknown as ILPPFactory,
      tA, tB, npm, payer
    )

    // align to (token0, token1) after sorting inside the seeder
    token0 = (String(tA.target).toLowerCase() === seeded.token0.toLowerCase()) ? tA : tB
    token1 = (token0 === tA) ? tB : tA
    pool   = seeded.pool

    // deploy PairFlash (router, factory, WETH9)
    const flashFactory = await ethers.getContractFactory('PairFlash')
    const flash = (await flashFactory.deploy(
      router.target,
      factory.target,
      weth9.target
    )) as unknown as PairFlash
    await flash.waitForDeployment()

    return { factory, flash }
  }

  beforeEach(async () => {
    ({ factory, flash } = await loadFixture(fixture))
  })

  describe('flash', () => {
    it('zero-fee pool is initialized and liquid (no quoter)', async () => {
      const slot0 = await pool.slot0()
      const L = await pool.liquidity()
      expect(slot0.sqrtPriceX96).to.not.equal(0n)
      expect(L).to.be.gt(0n)
    })

    it('reverts with LOK when flash tries to supplicate the same zero-fee pool (non-reentrant by design)', async () => {
      const params = {
        token0: String(token0.target),
        token1: String(token1.target),
        fee1:   FeeAmount.ZERO, // flash on 0-fee pool
        fee2:   FeeAmount.ZERO, // would route token1->token0 on same 0-fee pool
        fee3:   FeeAmount.ZERO, // then token0->token1 on same 0-fee pool
        amount0: 1_000,
        amount1: 1_000,
      } as any

      await expect(flash.initFlash(params)).to.be.revertedWith('LOK')
    })
  })
})