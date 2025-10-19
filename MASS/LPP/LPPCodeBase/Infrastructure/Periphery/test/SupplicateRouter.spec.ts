// test/SupplicateRouter.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import {
  ContractTransactionResponse,
  MaxUint256,
  ZeroAddress,
} from 'ethers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'

import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/internal/withArgs.js'

import type {
  IWETH9,
  MockTimeNonfungiblePositionManager,
  MockTimeSupplicateRouter,
  TestERC20,
} from '../typechain-types/periphery'

import completeFixture from './shared/completeFixture.ts'
import { FeeAmount, TICK_SPACINGS } from './shared/constants.ts'
import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'
import { expandTo18Decimals } from './shared/expandTo18Decimals.ts'
import { expect } from './shared/expect.ts'
import { encodePath } from './shared/path.ts'
import { getMaxTick, getMinTick } from './shared/ticks.ts'
import { computePoolAddress } from './shared/computePoolAddress.ts'

import type { ILPPFactory } from '../typechain-types/protocol'

describe('SupplicateRouter', function () {
  this.timeout(40000)

  let wallet: HardhatEthersSigner
  let trader: HardhatEthersSigner

  // ZERO FEES ONLY FOREVER
  const FEE = FeeAmount.ZERO
  const liquidity = 1_000_000
  const DEADLINE = MaxUint256 // avoid spurious deadline reverts in long test runs

  const addrEq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

  async function swapRouterFixture() {
    const wallets = await ethers.getSigners()
    const provider = ethers.provider
    ;[wallet, trader] = wallets as unknown as [HardhatEthersSigner, HardhatEthersSigner]

    const { weth9, factory, router, tokens, nft } = await completeFixture(wallets as any, provider)

    const routerAddr = await router.getAddress()
    const nftAddr = await nft.getAddress()
    const traderAddr = await trader.getAddress()

    // approve & fund wallets (WAIT for mining)
    for (const token of tokens) {
      await (await token.approve(routerAddr, MaxUint256)).wait()
      await (await token.approve(nftAddr, MaxUint256)).wait()
      await (await token.connect(trader).approve(routerAddr, MaxUint256)).wait()
      await (await token.transfer(traderAddr, expandTo18Decimals(1_000_000))).wait()
    }

    return {
      weth9,
      factory,
      router,
      tokens,
      nft,
    }
  }

  let factory: ILPPFactory
  let weth9: IWETH9
  let router: MockTimeSupplicateRouter
  let nft: MockTimeNonfungiblePositionManager
  let tokens: [TestERC20, TestERC20, TestERC20]

  let getBalances: (
    who: string
  ) => Promise<{
    weth9: bigint
    token0: bigint
    token1: bigint
    token2: bigint
  }>

  const nonZero = (x: bigint) => x > 0n

  const assertDecreasedBy = (after: bigint, before: bigint) => {
    expect(after).to.be.lt(before)
    expect(before - after).to.satisfy(nonZero)
  }
  const assertIncreasedBy = (after: bigint, before: bigint) => {
    expect(after).to.be.gt(before)
    expect(after - before).to.satisfy(nonZero)
  }

  // WETH9 pool helper with slight price tilt
  async function createPoolWETH9(tokenAddress: string) {
    const nftAddr = await nft.getAddress()
    await (await weth9.deposit({ value: BigInt(liquidity) })).wait()
    await (await weth9.approve(nftAddr, MaxUint256)).wait()

    let a = await weth9.getAddress()
    let b = tokenAddress
    if (a.toLowerCase() > b.toLowerCase()) [a, b] = [b, a]

    await (await nft.createAndInitializePoolIfNecessary(
      a, b, FEE, encodePriceSqrt(1001, 1000)
    )).wait()

    const spacing = TICK_SPACINGS[FEE]
    const recipient = await wallet.getAddress()
    await (await nft.mint({
      token0: a, token1: b, fee: FEE,
      tickLower: -100 * spacing, tickUpper: 100 * spacing,
      recipient,
      amount0Desired: liquidity, amount1Desired: liquidity,
      amount0Min: 0, amount1Min: 0, deadline: 1,
    })).wait()
  }

  beforeEach('load fixture', async () => {
    const fix = await loadFixture(swapRouterFixture)
    router  = fix.router
    weth9   = fix.weth9
    factory = fix.factory
    tokens  = fix.tokens
    nft     = fix.nft

    // define getBalances AFTER the sort so indices match the rest of the tests
    getBalances = async (who: string) => {
      const [w, t0, t1, t2] = await Promise.all([
        weth9.balanceOf(who),
        tokens[0].balanceOf(who),
        tokens[1].balanceOf(who),
        tokens[2].balanceOf(who),
      ])
      return { weth9: w, token0: t0, token1: t1, token2: t2 }
    }
  })

  // Create pools once per test
  beforeEach('create 0-1 and 1-2 pools', async () => {
    const spacing = TICK_SPACINGS[FEE]
    const tickLower = -100 * spacing
    const tickUpper =  100 * spacing
    const recipient = await wallet.getAddress()

    // === t0–t1 ===
    const t0 = await tokens[0].getAddress()
    const t1 = await tokens[1].getAddress()
    let a = t0, b = t1
    if (a.toLowerCase() > b.toLowerCase()) [a, b] = [b, a]

    // nudge initial price slightly off 1:1
    const txInit01 = await nft.createAndInitializePoolIfNecessary(
      a, b, FEE, encodePriceSqrt(1001, 1000)
    )
    await txInit01.wait()

    const txMint01 = await nft.mint({
      token0: a,
      token1: b,
      fee: FEE,
      tickLower,
      tickUpper,
      recipient,
      amount0Desired: liquidity,
      amount1Desired: liquidity,
      amount0Min: 0,
      amount1Min: 0,
      deadline: 1,
    })
    await txMint01.wait()

    // === t1–t2 ===
    const t2 = await tokens[2].getAddress()
    a = t1; b = t2
    if (a.toLowerCase() > b.toLowerCase()) [a, b] = [b, a]

    const txInit12 = await nft.createAndInitializePoolIfNecessary(
      a, b, FEE, encodePriceSqrt(1001, 1000)
    )
    await txInit12.wait()

    const txMint12 = await nft.mint({
      token0: a,
      token1: b,
      fee: FEE,
      tickLower,
      tickUpper,
      recipient,
      amount0Desired: liquidity,
      amount1Desired: liquidity,
      amount0Min: 0,
      amount1Min: 0,
      deadline: 1,
    })
    await txMint12.wait()
  })

  it('bytecode size', async () => {
    const addr = await router.getAddress()
    const code = await ethers.provider.getCode(addr)
    expect(((code.length - 2) / 2) as number).to.matchSnapshot()
  })

  describe('swaps', () => {
    //
    // ────────────────────────────────────────────────────────────────────
    //  #exactInput
    // ────────────────────────────────────────────────────────────────────
    //
    describe('#exactInput', () => {
      async function exactInput(
        tokenAddrs: string[],
        amountIn = 3,
        amountOutMinimum = 1
      ): Promise<ContractTransactionResponse> {
        const wethAddr   = await weth9.getAddress()
        const traderAddr = await trader.getAddress()
        const routerAddr = await router.getAddress()

        const inputIsWETH = addrEq(wethAddr, tokenAddrs[0])
        const outputIsWETH9 = addrEq(tokenAddrs[tokenAddrs.length - 1], wethAddr)

        const value = inputIsWETH ? BigInt(amountIn) : 0n

        const params = {
          path: encodePath(tokenAddrs, new Array(tokenAddrs.length - 1).fill(FEE)),
          recipient: outputIsWETH9 ? routerAddr : traderAddr,
          deadline: DEADLINE,
          amountIn,
          amountOutMinimum,
        }

        const data = [router.interface.encodeFunctionData('exactInput', [params])]
        if (outputIsWETH9)
          // unwrap whatever we received (no min on unwrap itself)
          data.push(router.interface.encodeFunctionData('unwrapWETH9', [0, traderAddr]))

        // sanity: force a revert with absurd min (on the swap step)
        const _origMin = params.amountOutMinimum
        params.amountOutMinimum = 1_000_000_000
        await expect(router.connect(trader).exactInput(params, { value })).to.be.reverted
        params.amountOutMinimum = _origMin

        return data.length === 1
          ? router.connect(trader).exactInput(params, { value })
          : router.connect(trader).multicall(data, { value })
      }

      describe('single-pool', () => {
        it('0 -> 1', async () => {
          const t0 = await tokens[0].getAddress()
          const t1 = await tokens[1].getAddress()
          const pool = await factory.getPool(t0, t1, FEE)

          const poolBefore = await getBalances(pool)
          const traderBefore = await getBalances(await trader.getAddress())

          await exactInput([t0, t1])

          const poolAfter = await getBalances(pool)
          const traderAfter = await getBalances(await trader.getAddress())

          assertDecreasedBy(traderAfter.token0, traderBefore.token0)
          assertIncreasedBy(traderAfter.token1, traderBefore.token1)
          assertIncreasedBy(poolAfter.token0, poolBefore.token0)
          assertDecreasedBy(poolAfter.token1, poolBefore.token1)
        })

        it('1 -> 0', async () => {
          const t0 = await tokens[0].getAddress()
          const t1 = await tokens[1].getAddress()
          const pool = await factory.getPool(t1, t0, FEE)

          const poolBefore = await getBalances(pool)
          const traderBefore = await getBalances(await trader.getAddress())

          await exactInput([t1, t0])

          const poolAfter = await getBalances(pool)
          const traderAfter = await getBalances(await trader.getAddress())

          assertIncreasedBy(traderAfter.token0, traderBefore.token0)
          assertDecreasedBy(traderAfter.token1, traderBefore.token1)
          assertDecreasedBy(poolAfter.token0, poolBefore.token0)
          assertIncreasedBy(poolAfter.token1, poolBefore.token1)
        })
      })

      describe('multi-pool', () => {
        it('0 -> 1 -> 2', async () => {
          const t0 = await tokens[0].getAddress()
          const t1 = await tokens[1].getAddress()
          const t2 = await tokens[2].getAddress()

          const traderBefore = await getBalances(await trader.getAddress())
          await exactInput([t0, t1, t2], 5, 1)
          const traderAfter = await getBalances(await trader.getAddress())

          assertDecreasedBy(traderAfter.token0, traderBefore.token0)
          assertIncreasedBy(traderAfter.token2, traderBefore.token2)
        })

        it('2 -> 1 -> 0', async () => {
          const t0 = await tokens[0].getAddress()
          const t1 = await tokens[1].getAddress()
          const t2 = await tokens[2].getAddress()

          const traderBefore = await getBalances(await trader.getAddress())
          await exactInput([t2, t1, t0], 5, 1)
          const traderAfter = await getBalances(await trader.getAddress())

          assertDecreasedBy(traderAfter.token2, traderBefore.token2)
          assertIncreasedBy(traderAfter.token0, traderBefore.token0)
        })

        it('events', async () => {
          const factoryAddr = await factory.getAddress()
          const t0 = await tokens[0].getAddress()
          const t1 = await tokens[1].getAddress()
          const t2 = await tokens[2].getAddress()
          const traderAddr = await trader.getAddress()
          const routerAddr = await router.getAddress()

          await expect(exactInput([t0, t1, t2], 5, 1))
            .to.emit(tokens[0], 'Transfer')
            .withArgs(
              traderAddr,
              computePoolAddress(factoryAddr, [t0, t1], FEE),
              anyValue
            )
            .to.emit(tokens[1], 'Transfer')
            .withArgs(
              computePoolAddress(factoryAddr, [t0, t1], FEE),
              routerAddr,
              anyValue
            )
            .to.emit(tokens[1], 'Transfer')
            .withArgs(
              routerAddr,
              computePoolAddress(factoryAddr, [t1, t2], FEE),
              anyValue
            )
            .to.emit(tokens[2], 'Transfer')
            .withArgs(
              computePoolAddress(factoryAddr, [t1, t2], FEE),
              traderAddr,
              anyValue
            )
        })
      })

      describe('ETH input', () => {
        describe('WETH9', () => {
          beforeEach(async () => {
            await createPoolWETH9(await tokens[0].getAddress())
          })

          it('WETH9 -> 0', async () => {
            const w = await weth9.getAddress()
            const t0 = await tokens[0].getAddress()
            const routerAddr = await router.getAddress()

            const pool = await factory.getPool(w, t0, FEE)

            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(await trader.getAddress())

            await expect(exactInput([w, t0]))
              .to.emit(weth9, 'Deposit')
              .withArgs(routerAddr, anyValue)

            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(await trader.getAddress())

            assertIncreasedBy(traderAfter.token0, traderBefore.token0)
            assertIncreasedBy(poolAfter.weth9, poolBefore.weth9)
            assertDecreasedBy(poolAfter.token0, poolBefore.token0)
          })

          it('WETH9 -> 0 -> 1', async () => {
            const w = await weth9.getAddress()
            const t0 = await tokens[0].getAddress()
            const t1 = await tokens[1].getAddress()
            const routerAddr = await router.getAddress()

            const traderBefore = await getBalances(await trader.getAddress())

            await expect(exactInput([w, t0, t1], 5))
              .to.emit(weth9, 'Deposit')
              .withArgs(routerAddr, anyValue)

            const traderAfter = await getBalances(await trader.getAddress())
            assertIncreasedBy(traderAfter.token1, traderBefore.token1)
          })
        })
      })

      describe('ETH output', () => {
        describe('WETH9', () => {
          beforeEach(async () => {
            await createPoolWETH9(await tokens[0].getAddress())
            await createPoolWETH9(await tokens[1].getAddress())
          })

          it('0 -> WETH9', async () => {
            const w = await weth9.getAddress()
            const t0 = await tokens[0].getAddress()
            const routerAddr = await router.getAddress()

            const pool = await factory.getPool(t0, w, FEE)

            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(await trader.getAddress())

            await expect(exactInput([t0, w], 10, 0))
              .to.emit(weth9, 'Withdrawal')
              .withArgs(routerAddr, anyValue)

            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(await trader.getAddress())

            assertDecreasedBy(traderAfter.token0, traderBefore.token0)
            assertDecreasedBy(poolAfter.weth9, poolBefore.weth9)
            assertIncreasedBy(poolAfter.token0, poolBefore.token0)
          })

          it('0 -> 1 -> WETH9', async () => {
            const w = await weth9.getAddress()
            const t0 = await tokens[0].getAddress()
            const t1 = await tokens[1].getAddress()
            const routerAddr = await router.getAddress()

            const traderBefore = await getBalances(await trader.getAddress())

            await expect(exactInput([t0, t1, w], 5))
              .to.emit(weth9, 'Withdrawal')
              .withArgs(routerAddr, anyValue)

            const traderAfter = await getBalances(await trader.getAddress())
            assertDecreasedBy(traderAfter.token0, traderBefore.token0)
          })
        })
      })
    })

    //
    // ────────────────────────────────────────────────────────────────────
    //  #exactInputSingle
    // ────────────────────────────────────────────────────────────────────
    //
    describe('#exactInputSingle', () => {
      async function exactInputSingle(
        tokenIn: string,
        tokenOut: string,
        amountIn = 3,
        amountOutMinimum = 1,
        sqrtPriceLimitX96?: bigint
      ): Promise<ContractTransactionResponse> {
        const wethAddr   = await weth9.getAddress()
        const traderAddr = await trader.getAddress()
        const routerAddr = await router.getAddress()

        const inputIsWETH  = addrEq(wethAddr, tokenIn)
        const outputIsWETH = addrEq(tokenOut, wethAddr)

        const value = inputIsWETH ? BigInt(amountIn) : 0n

        const LIMIT_MIN = 4_295_128_740n
        const LIMIT_MAX = 1461446703485210103287273052203988822378723970341n

        const params = {
          tokenIn,
          tokenOut,
          fee: FEE,
          sqrtPriceLimitX96:
            sqrtPriceLimitX96 ??
            (tokenIn.toLowerCase() < tokenOut.toLowerCase() ? LIMIT_MIN : LIMIT_MAX),
          recipient: outputIsWETH ? routerAddr : traderAddr,
          deadline: DEADLINE,
          amountIn,
          amountOutMinimum,
        }

        const data = [router.interface.encodeFunctionData('exactInputSingle', [params])]
        if (outputIsWETH)
          data.push(router.interface.encodeFunctionData('unwrapWETH9', [0, traderAddr]))

        // sanity: force a revert with absurd min on swap
        const _origMin = params.amountOutMinimum
        ;(params as any).amountOutMinimum = 1_000_000_000
        await expect(router.connect(trader).exactInputSingle(params, { value })).to.be.reverted
        ;(params as any).amountOutMinimum = _origMin

        return data.length === 1
          ? router.connect(trader).exactInputSingle(params, { value })
          : router.connect(trader).multicall(data, { value })
      }

      it('0 -> 1', async () => {
        const t0 = await tokens[0].getAddress()
        const t1 = await tokens[1].getAddress()
        const pool = await factory.getPool(t0, t1, FEE)

        const poolBefore = await getBalances(pool)
        const traderBefore = await getBalances(await trader.getAddress())

        await exactInputSingle(t0, t1)

        const poolAfter = await getBalances(pool)
        const traderAfter = await getBalances(await trader.getAddress())

        assertDecreasedBy(traderAfter.token0, traderBefore.token0)
        assertIncreasedBy(traderAfter.token1, traderBefore.token1)
        assertIncreasedBy(poolAfter.token0, poolBefore.token0)
        assertDecreasedBy(poolAfter.token1, poolBefore.token1)
      })

      it('1 -> 0', async () => {
        const t0 = await tokens[0].getAddress()
        const t1 = await tokens[1].getAddress()
        const pool = await factory.getPool(t1, t0, FEE)

        const poolBefore = await getBalances(pool)
        const traderBefore = await getBalances(await trader.getAddress())

        await exactInputSingle(t1, t0)

        const poolAfter = await getBalances(pool)
        const traderAfter = await getBalances(await trader.getAddress())

        assertIncreasedBy(traderAfter.token0, traderBefore.token0)
        assertDecreasedBy(traderAfter.token1, traderBefore.token1)
        assertDecreasedBy(poolAfter.token0, poolBefore.token0)
        assertIncreasedBy(poolAfter.token1, poolBefore.token1)
      })

      describe('ETH input', () => {
        describe('WETH9', () => {
          beforeEach(async () => {
            await createPoolWETH9(await tokens[0].getAddress())
          })

          it('WETH9 -> 0', async () => {
            const w = await weth9.getAddress()
            const t0 = await tokens[0].getAddress()
            const routerAddr = await router.getAddress()

            const pool = await factory.getPool(w, t0, FEE)

            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(await trader.getAddress())

            await expect(exactInputSingle(w, t0))
              .to.emit(weth9, 'Deposit')
              .withArgs(routerAddr, anyValue)

            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(await trader.getAddress())

            assertIncreasedBy(traderAfter.token0, traderBefore.token0)
            assertIncreasedBy(poolAfter.weth9, poolBefore.weth9)
            assertDecreasedBy(poolAfter.token0, poolBefore.token0)
          })
        })
      })

      describe('ETH output', () => {
        describe('WETH9', () => {
          beforeEach(async () => {
            await createPoolWETH9(await tokens[0].getAddress())
            await createPoolWETH9(await tokens[1].getAddress())
          })

          it('0 -> WETH9', async () => {
            const w = await weth9.getAddress()
            const t0 = await tokens[0].getAddress()
            const routerAddr = await router.getAddress()

            const pool = await factory.getPool(t0, w, FEE)

            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(await trader.getAddress())

            await expect(exactInputSingle(t0, w))
              .to.emit(weth9, 'Withdrawal')
              .withArgs(routerAddr, anyValue)

            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(await trader.getAddress())

            assertDecreasedBy(traderAfter.token0, traderBefore.token0)
            assertDecreasedBy(poolAfter.weth9, poolBefore.weth9)
            assertIncreasedBy(poolAfter.token0, poolBefore.token0)
          })
        })
      })
    })

    //
    // ────────────────────────────────────────────────────────────────────
    //  #exactOutput
    // ────────────────────────────────────────────────────────────────────
    //
    describe('#exactOutput', () => {
      async function exactOutput(
        tokenAddrs: string[],
        amountOut = 1,
        amountInMaximum = 5
      ): Promise<ContractTransactionResponse> {
        const wethAddr   = await weth9.getAddress()
        const traderAddr = await trader.getAddress()
        const routerAddr = await router.getAddress()

        const inputIsWETH9  = addrEq(tokenAddrs[0], wethAddr)
        const outputIsWETH9 = addrEq(tokenAddrs[tokenAddrs.length - 1], wethAddr)

        const value = inputIsWETH9 ? BigInt(amountInMaximum) : 0n

        const params = {
          path: encodePath(tokenAddrs.slice().reverse(), new Array(tokenAddrs.length - 1).fill(FEE)),
          recipient: outputIsWETH9 ? routerAddr : traderAddr,
          deadline: DEADLINE,
          amountOut,
          amountInMaximum,
        }

        const data = [router.interface.encodeFunctionData('exactOutput', [params])]
        if (inputIsWETH9) data.push(router.interface.encodeFunctionData('refundETH'))
        if (outputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [0, traderAddr]))

        const _origMax = params.amountInMaximum
        ;(params as any).amountInMaximum = 0 // impossible, guarantees failure
        await expect(router.connect(trader).exactOutput(params, { value })).to.be.reverted
        ;(params as any).amountInMaximum = _origMax

        return router.connect(trader).multicall(data, { value })
      }

      describe('single-pool', () => {
        it('0 -> 1', async () => {
          const t0 = await tokens[0].getAddress()
          const t1 = await tokens[1].getAddress()
          const pool = await factory.getPool(t0, t1, FEE)

          const poolBefore = await getBalances(pool)
          const traderBefore = await getBalances(await trader.getAddress())

          await exactOutput([t0, t1])

          const poolAfter = await getBalances(pool)
          const traderAfter = await getBalances(await trader.getAddress())

          assertDecreasedBy(traderAfter.token0, traderBefore.token0) // spent some 0
          assertIncreasedBy(traderAfter.token1, traderBefore.token1) // got exact 1 (≥1)
          assertIncreasedBy(poolAfter.token0, poolBefore.token0)
          assertDecreasedBy(poolAfter.token1, poolBefore.token1)
        })

        it('1 -> 0', async () => {
          const t0 = await tokens[0].getAddress()
          const t1 = await tokens[1].getAddress()
          const pool = await factory.getPool(t1, t0, FEE)

          const poolBefore = await getBalances(pool)
          const traderBefore = await getBalances(await trader.getAddress())

          await exactOutput([t1, t0])

          const poolAfter = await getBalances(pool)
          const traderAfter = await getBalances(await trader.getAddress())

          assertIncreasedBy(traderAfter.token0, traderBefore.token0)
          assertDecreasedBy(traderAfter.token1, traderBefore.token1)
          assertDecreasedBy(poolAfter.token0, poolBefore.token0)
          assertIncreasedBy(poolAfter.token1, poolBefore.token1)
        })
      })

      describe('multi-pool', () => {
        it('0 -> 1 -> 2', async () => {
          const t0 = await tokens[0].getAddress()
          const t1 = await tokens[1].getAddress()
          const t2 = await tokens[2].getAddress()

        const traderBefore = await getBalances(await trader.getAddress())
        await exactOutput([t0, t1, t2], 1, 5)
        const traderAfter = await getBalances(await trader.getAddress())

        assertDecreasedBy(traderAfter.token0, traderBefore.token0)
        assertIncreasedBy(traderAfter.token2, traderBefore.token2)
        })

        it('2 -> 1 -> 0', async () => {
          const t0 = await tokens[0].getAddress()
          const t1 = await tokens[1].getAddress()
          const t2 = await tokens[2].getAddress()

          const traderBefore = await getBalances(await trader.getAddress())
          await exactOutput([t2, t1, t0], 1, 5)
          const traderAfter = await getBalances(await trader.getAddress())

          assertDecreasedBy(traderAfter.token2, traderBefore.token2)
          assertIncreasedBy(traderAfter.token0, traderBefore.token0)
        })

        it('events', async () => {
          const factoryAddr = await factory.getAddress()
          const t0 = await tokens[0].getAddress()
          const t1 = await tokens[1].getAddress()
          const t2 = await tokens[2].getAddress()
          const traderAddr = await trader.getAddress()

          await expect(exactOutput([t0, t1, t2], 1, 5))
            .to.emit(tokens[2], 'Transfer')
            .withArgs(
              computePoolAddress(factoryAddr, [t2, t1], FEE),
              traderAddr,
              anyValue
            )
            .to.emit(tokens[1], 'Transfer')
            .withArgs(
              computePoolAddress(factoryAddr, [t1, t0], FEE),
              computePoolAddress(factoryAddr, [t2, t1], FEE),
              anyValue
            )
            .to.emit(tokens[0], 'Transfer')
            .withArgs(
              traderAddr,
              computePoolAddress(factoryAddr, [t1, t0], FEE),
              anyValue
            )
        })
      })

      describe('ETH input', () => {
        describe('WETH9', () => {
          beforeEach(async () => {
            await createPoolWETH9(await tokens[0].getAddress())
          })

          it('WETH9 -> 0', async () => {
            const w = await weth9.getAddress()
            const t0 = await tokens[0].getAddress()
            const routerAddr = await router.getAddress()

            const pool = await factory.getPool(w, t0, FEE)

            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(await trader.getAddress())

            await expect(exactOutput([w, t0]))
              .to.emit(weth9, 'Deposit')
              .withArgs(routerAddr, anyValue)

            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(await trader.getAddress())

            assertIncreasedBy(traderAfter.token0, traderBefore.token0)
            assertIncreasedBy(poolAfter.weth9, poolBefore.weth9)
            assertDecreasedBy(poolAfter.token0, poolBefore.token0)
          })

          it('WETH9 -> 0 -> 1', async () => {
            const w = await weth9.getAddress()
            const t0 = await tokens[0].getAddress()
            const t1 = await tokens[1].getAddress()
            const routerAddr = await router.getAddress()

            const traderBefore = await getBalances(await trader.getAddress())

            await expect(exactOutput([w, t0, t1], 1, 5))
              .to.emit(weth9, 'Deposit')
              .withArgs(routerAddr, anyValue)

            const traderAfter = await getBalances(await trader.getAddress())
            assertIncreasedBy(traderAfter.token1, traderBefore.token1)
          })
        })
      })

      describe('ETH output', () => {
        describe('WETH9', () => {
          beforeEach(async () => {
            await createPoolWETH9(await tokens[0].getAddress())
            await createPoolWETH9(await tokens[1].getAddress())
          })

          it('0 -> WETH9', async () => {
            const w = await weth9.getAddress()
            const t0 = await tokens[0].getAddress()
            const routerAddr = await router.getAddress()

            const pool = await factory.getPool(t0, w, FEE)

            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(await trader.getAddress())

            await expect(exactOutput([t0, w]))
              .to.emit(weth9, 'Withdrawal')
              .withArgs(routerAddr, anyValue)

            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(await trader.getAddress())

            assertDecreasedBy(traderAfter.token0, traderBefore.token0)
            assertDecreasedBy(poolAfter.weth9, poolBefore.weth9)
            assertIncreasedBy(poolAfter.token0, poolBefore.token0)
          })

          it('0 -> 1 -> WETH9', async () => {
            const w = await weth9.getAddress()
            const t0 = await tokens[0].getAddress()
            const t1 = await tokens[1].getAddress()
            const routerAddr = await router.getAddress()

            const traderBefore = await getBalances(await trader.getAddress())

            await expect(exactOutput([t0, t1, w], 1, 5))
              .to.emit(weth9, 'Withdrawal')
              .withArgs(routerAddr, anyValue)

            const traderAfter = await getBalances(await trader.getAddress())
            assertDecreasedBy(traderAfter.token0, traderBefore.token0)
          })
        })
      })
    })

    //
    // ────────────────────────────────────────────────────────────────────
    //  #exactOutputSingle
    // ────────────────────────────────────────────────────────────────────
    //
    describe('#exactOutputSingle', () => {
      async function exactOutputSingle(
        tokenIn: string,
        tokenOut: string,
        amountOut = 1,
        amountInMaximum = 5,
        sqrtPriceLimitX96?: bigint
      ): Promise<ContractTransactionResponse> {
        const wethAddr   = await weth9.getAddress()
        const traderAddr = await trader.getAddress()
        const routerAddr = await router.getAddress()

        const inputIsWETH9  = addrEq(tokenIn, wethAddr)
        const outputIsWETH9 = addrEq(tokenOut, wethAddr)
        const value = inputIsWETH9 ? BigInt(amountInMaximum) : 0n

        const LIMIT_MIN = 4_295_128_740n
        const LIMIT_MAX = 1461446703485210103287273052203988822378723970341n

        const params = {
          tokenIn,
          tokenOut,
          fee: FEE,
          sqrtPriceLimitX96:
            sqrtPriceLimitX96 ??
            (tokenIn.toLowerCase() < tokenOut.toLowerCase() ? LIMIT_MIN : LIMIT_MAX),
          recipient: outputIsWETH9 ? routerAddr : traderAddr,
          deadline: DEADLINE,
          amountOut,
          amountInMaximum,
        }

        const data = [router.interface.encodeFunctionData('exactOutputSingle', [params])]
        if (inputIsWETH9) data.push(router.interface.encodeFunctionData('refundETH'))
        if (outputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [0, traderAddr]))

        // sanity revert
        const origMax = params.amountInMaximum
        ;(params as any).amountInMaximum = 0
        await expect(router.connect(trader).exactOutputSingle(params, { value })).to.be.reverted
        ;(params as any).amountInMaximum = origMax

        return data.length === 1
          ? router.connect(trader).exactOutputSingle(params, { value })
          : router.connect(trader).multicall(data, { value })
      }

      it('0 -> 1', async () => {
        const t0 = await tokens[0].getAddress()
        const t1 = await tokens[1].getAddress()
        const pool = await factory.getPool(t0, t1, FEE)

        const poolBefore = await getBalances(pool)
        const traderBefore = await getBalances(await trader.getAddress())

        await exactOutputSingle(t0, t1)

        const poolAfter = await getBalances(pool)
        const traderAfter = await getBalances(await trader.getAddress())

        // spent some t0, got exact t1
        expect(traderAfter.token1).to.be.gt(traderBefore.token1)
        expect(traderAfter.token0).to.be.lt(traderBefore.token0)
        expect(poolAfter.token0).to.be.gt(poolBefore.token0)
        expect(poolAfter.token1).to.be.lt(poolBefore.token1)
      })
    })
  })
})