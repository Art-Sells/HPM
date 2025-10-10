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
  let router: any // NEW

  async function fixture() {
    const signers = await ethers.getSigners()
    wallet = signers[0]

    // completeFixture returns { router, tokens, factory, weth9 }
    const { router: r, tokens, factory, weth9 } = await completeFixture(signers, ethers.provider)
    const [t0, t1] = tokens as TestERC20[]

    const flashFactory = await ethers.getContractFactory('PairFlash')
    const flash = (await flashFactory.deploy(
      r.target,         // router
      factory.target,   // factory
      weth9.target      // WETH9
    )) as unknown as PairFlash
    await flash.waitForDeployment()

    const quoterFactory = await ethers.getContractFactory('SupplicateQuoter')
    const quoter = (await quoterFactory.deploy(
      factory.target,
      weth9.target
    )) as unknown as SupplicateQuoter
    await quoter.waitForDeployment()

    return { token0: t0, token1: t1, flash, factory, quoter, router: r } // NEW
  }

  // NEW: Inline zero-fee pool setup (no other file changes)
// --- replace the whole setupZeroFeePool with this ---
async function setupZeroFeePool() {
  const ZERO = FeeAmount.ZERO;

  // 1) Ensure ZERO tier is enabled
  try {
    const spacing = await (factory as any).feeAmountTickSpacing?.(ZERO);
    if (!spacing || Number(spacing) === 0) {
      await (factory as any).enableFeeAmount(ZERO, 1);
    }
  } catch {
    await (factory as any).enableFeeAmount(ZERO, 1);
  }

  // 2) Create pool if needed
  let poolAddress = await factory.getPool(token0.target, token1.target, ZERO);
  if (poolAddress === ethers.ZeroAddress) {
    const tx = await factory.createPool(token0.target, token1.target, ZERO);
    await tx.wait();
    poolAddress = await factory.getPool(token0.target, token1.target, ZERO);
  }

  // 3) Initialize price (or use router helper if it has it)
  const pool = await ethers.getContractAt('ILPPPool', poolAddress);
  const slot0 = await pool.slot0();
  const sqrtP = encodePriceSqrt(1, 1);

  // Some routers have createAndInitializePoolIfNecessary. Prefer that if present.
  const r: any = router as any;
  const hasFn = (name: string) => {
    try { return !!r.getFunction?.(name) || typeof r[name] === 'function'; } catch { return false; }
  };

  if (slot0.sqrtPriceX96 === 0n) {
    if (hasFn('createAndInitializePoolIfNecessary')) {
      // Try both flat & struct shapes
      try {
        await (await r.createAndInitializePoolIfNecessary(
          token0.target, token1.target, ZERO, sqrtP
        )).wait();
      } catch {
        // struct version: { token0, token1, fee, sqrtPriceX96 }
        try {
          await (await r.createAndInitializePoolIfNecessary({
            token0: token0.target, token1: token1.target, fee: ZERO, sqrtPriceX96: sqrtP
          })).wait();
        } catch {
          // fallback to direct pool.initialize
          await (await pool.initialize(sqrtP)).wait();
        }
      }
    } else {
      await (await pool.initialize(sqrtP)).wait();
    }
  }

  // 4) Seed tiny liquidity via whatever entrypoint the router actually has
  const amount0 = 10n ** 18n;
  const amount1 = 10n ** 18n;
  await (await token0.connect(wallet).approve(router.target, amount0)).wait();
  await (await token1.connect(wallet).approve(router.target, amount1)).wait();

  const latest = await ethers.provider.getBlock('latest');
  const deadline = BigInt((latest?.timestamp ?? 0) + 3600);
  const lower = -887220;
  const upper =  887220;

  // Try a battery of common names / shapes:
  const tryCalls: Array<() => Promise<boolean>> = [
    // 4.1 Uniswap-v3-style "mint(params)"
    async () => {
      if (!hasFn('mint')) return false;
      try {
        await (await r.mint({
          token0: token0.target,
          token1: token1.target,
          fee: ZERO,
          tickLower: lower,
          tickUpper: upper,
          amount0Desired: amount0,
          amount1Desired: amount1,
          amount0Min: 0,
          amount1Min: 0,
          recipient: await wallet.getAddress(),
          deadline,
        })).wait();
        return true;
      } catch { return false; }
    },

    // 4.2 addLiquidity(params) with tokenA/B
    async () => {
      if (!hasFn('addLiquidity')) return false;
      try {
        await (await r.addLiquidity({
          tokenA: token0.target,
          tokenB: token1.target,
          fee: ZERO,
          tickLower: lower,
          tickUpper: upper,
          amountADesired: amount0,
          amountBDesired: amount1,
          amountAMin: 0,
          amountBMin: 0,
          recipient: await wallet.getAddress(),
          deadline,
        })).wait();
        return true;
      } catch { return false; }
    },

    // 4.3 addLiquidity flat args (some routers don’t use structs)
    async () => {
      if (!hasFn('addLiquidity')) return false;
      try {
        await (await r.addLiquidity(
          token0.target, token1.target, ZERO,
          lower, upper,
          amount0, amount1,
          0, 0,
          await wallet.getAddress(),
          deadline
        )).wait();
        return true;
      } catch { return false; }
    },

    // 4.4 Other common aliases with struct
    async () => {
      const name = ['mintPosition','mintNewPosition','addLiquidityV3','provideLiquidity','seedLiquidity']
        .find(hasFn);
      if (!name) return false;
      try {
        await (await r[name]({
          token0: token0.target,
          token1: token1.target,
          fee: ZERO,
          tickLower: lower,
          tickUpper: upper,
          amount0Desired: amount0,
          amount1Desired: amount1,
          amount0Min: 0,
          amount1Min: 0,
          recipient: await wallet.getAddress(),
          deadline,
        })).wait();
        return true;
      } catch { return false; }
    },
  ];

  for (const call of tryCalls) {
    if (await call()) {
      // sanity: has liquidity?
      if ((await pool.liquidity()) === 0n) throw new Error('Seed liquidity call succeeded but pool.liquidity()==0');
      return;
    }
  }

  // If we’re here, we didn’t find a match. Show available function names for a 10-second fix.
  const names = (router as any).interface?.fragments?.map((f: any) => f?.name).filter(Boolean) ?? [];
  throw new Error(
    `Router has no recognized liquidity function.\n` +
    `Available functions:\n- ${names.join('\n- ')}\n` +
    `Tell me which one should add liquidity (or paste its signature), and I’ll wire it in.`
  );
}

  beforeEach(async () => {
    ({ factory, token0, token1, flash, quoter, router } = await loadFixture(fixture)) // NEW
    await setupZeroFeePool() // NEW
  })

  describe('flash', () => {
    it('emits correct transfers (ZERO fee)', async () => {
      const amount0In = 1_000
      const amount1In = 1_000
      const fee0 = 0
      const fee1 = 0

      const flashParams = {
        token0:  token0.target,
        token1:  token1.target,
        fee:     FeeAmount.ZERO,
        amount0: amount0In,
        amount1: amount1In,
      } as any

      const pool = computePoolAddress(
        String(factory.target),
        [String(token0.target), String(token1.target)],
        FeeAmount.ZERO
      )

      // quotes under ZERO fee
      const expectedAmountOut0 = await quoter.quoteExactInputSingle.staticCall(
        token1.target, token0.target, FeeAmount.ZERO, amount1In, encodePriceSqrt(20, 10)
      )
      const expectedAmountOut1 = await quoter.quoteExactInputSingle.staticCall(
        token0.target, token1.target, FeeAmount.ZERO, amount0In, encodePriceSqrt(5, 10)
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
        token0:  token0.target,
        token1:  token1.target,
        fee:     FeeAmount.ZERO,
        amount0: 1_000,
        amount1: 1_000,
      } as any
      await snapshotGasCost(flash.initFlash(flashParams))
    })
  })
})