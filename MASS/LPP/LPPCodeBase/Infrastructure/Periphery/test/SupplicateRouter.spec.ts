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

  // ZERO fees only
  const FEE = FeeAmount.ZERO
  const liquidity = 1_000_000
  const DEADLINE = MaxUint256 // never expires

  async function swapRouterFixture() {
    const wallets = await ethers.getSigners()
    const provider = ethers.provider
    ;[wallet, trader] = wallets as unknown as [HardhatEthersSigner, HardhatEthersSigner]

    const { weth9, factory, router, tokens, nft } = await completeFixture(wallets as any, provider)

    const routerAddr = await router.getAddress()
    const nftAddr = await nft.getAddress()
    const traderAddr = await trader.getAddress()

    // approve & fund wallets
    for (const token of tokens) {
      await token.approve(routerAddr, MaxUint256)
      await token.approve(nftAddr, MaxUint256)
      await token.connect(trader).approve(routerAddr, MaxUint256)
      await token.transfer(traderAddr, expandTo18Decimals(1_000_000))
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

  // load fixture per test
  beforeEach('load fixture', async () => {
    ;({ router, weth9, factory, tokens, nft } = await loadFixture(swapRouterFixture))

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

  // ensure the swap router never ends up with a balance
  afterEach('router has zero balances', async () => {
    const routerAddr = await router.getAddress()
    const balances = await getBalances(routerAddr)
    expect(Object.values(balances).every((b) => b === 0n)).to.eq(true)

    const ethBal = await ethers.provider.getBalance(routerAddr)
    expect(ethBal === 0n).to.eq(true)
  })

  it('bytecode size', async () => {
    const addr = await router.getAddress()
    const code = await ethers.provider.getCode(addr)
    expect(((code.length - 2) / 2) as number).to.matchSnapshot()
  })

  describe('swaps', () => {
    async function createPool(tokenAddressA: string, tokenAddressB: string) {
      let a = tokenAddressA
      let b = tokenAddressB
      if (a.toLowerCase() > b.toLowerCase()) [a, b] = [b, a]

      await nft.createAndInitializePoolIfNecessary(
        a,
        b,
        FEE,
        encodePriceSqrt(1, 1)
      )

      const recipient = await wallet.getAddress()
      const liquidityParams = {
        token0: a,
        token1: b,
        fee: FEE,
        tickLower: getMinTick(TICK_SPACINGS[FEE]),
        tickUpper: getMaxTick(TICK_SPACINGS[FEE]),
        recipient,
        amount0Desired: liquidity,
        amount1Desired: liquidity,
        amount0Min: 0,
        amount1Min: 0,
        deadline: DEADLINE,
      }

      return nft.mint(liquidityParams)
    }

    async function createPoolWETH9(tokenAddress: string) {
      const nftAddr = await nft.getAddress()
      await weth9.deposit({ value: BigInt(liquidity) })
      await weth9.approve(nftAddr, MaxUint256)
      return createPool(await weth9.getAddress(), tokenAddress)
    }

    beforeEach('create 0-1 and 1-2 pools', async () => {
      await createPool(await tokens[0].getAddress(), await tokens[1].getAddress())
      await createPool(await tokens[1].getAddress(), await tokens[2].getAddress())
    })

    describe('#exactInput', () => {
      async function exactInput(
        tokenAddrs: string[],
        amountIn = 3,
        amountOutMinimum = 1
      ): Promise<ContractTransactionResponse> {
        const wethAddr = await weth9.getAddress()
        const traderAddr = await trader.getAddress()

        const inputIsWETH = wethAddr === tokenAddrs[0]
        const outputIsWETH9 = tokenAddrs[tokenAddrs.length - 1] === wethAddr

        const value = inputIsWETH ? BigInt(amountIn) : 0n

        const params = {
          path: encodePath(tokenAddrs, new Array(tokenAddrs.length - 1).fill(FEE)),
          recipient: outputIsWETH9 ? ZeroAddress : traderAddr,
          deadline: DEADLINE,
          amountIn,
          amountOutMinimum,
        }

        const data = [router.interface.encodeFunctionData('exactInput', [params])]
        if (outputIsWETH9)
          data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOutMinimum, traderAddr]))

        return data.length === 1
          ? router.connect(trader).exactInput(params, { value, gasLimit: 5_000_000 })
          : router.connect(trader).multicall(data, { value, gasLimit: 5_000_000 })
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

          expect(traderAfter.token0).to.eq(traderBefore.token0 - 3n)
          expect(traderAfter.token1).to.eq(traderBefore.token1 + 1n)
          expect(poolAfter.token0).to.eq(poolBefore.token0 + 3n)
          expect(poolAfter.token1).to.eq(poolBefore.token1 - 1n)
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

          expect(traderAfter.token0).to.eq(traderBefore.token0 + 1n)
          expect(traderAfter.token1).to.eq(traderBefore.token1 - 3n)
          expect(poolAfter.token0).to.eq(poolBefore.token0 - 1n)
          expect(poolAfter.token1).to.eq(poolBefore.token1 + 3n)
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

          expect(traderAfter.token0).to.eq(traderBefore.token0 - 5n)
          expect(traderAfter.token2).to.eq(traderBefore.token2 + 1n)
        })

        it('2 -> 1 -> 0', async () => {
          const t0 = await tokens[0].getAddress()
          const t1 = await tokens[1].getAddress()
          const t2 = await tokens[2].getAddress()

          const traderBefore = await getBalances(await trader.getAddress())
          await exactInput([t2, t1, t0], 5, 1)
          const traderAfter = await getBalances(await trader.getAddress())

          expect(traderAfter.token2).to.eq(traderBefore.token2 - 5n)
          expect(traderAfter.token0).to.eq(traderBefore.token0 + 1n)
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
              5n
            )
            .to.emit(tokens[1], 'Transfer')
            .withArgs(
              computePoolAddress(factoryAddr, [t0, t1], FEE),
              routerAddr,
              3n
            )
            .to.emit(tokens[1], 'Transfer')
            .withArgs(
              routerAddr,
              computePoolAddress(factoryAddr, [t1, t2], FEE),
              3n
            )
            .to.emit(tokens[2], 'Transfer')
            .withArgs(
              computePoolAddress(factoryAddr, [t1, t2], FEE),
              traderAddr,
              1n
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
              .withArgs(routerAddr, 3n)

            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(await trader.getAddress())

            expect(traderAfter.token0).to.eq(traderBefore.token0 + 1n)
            expect(poolAfter.weth9).to.eq(poolBefore.weth9 + 3n)
            expect(poolAfter.token0).to.eq(poolBefore.token0 - 1n)
          })

          it('WETH9 -> 0 -> 1', async () => {
            const w = await weth9.getAddress()
            const t0 = await tokens[0].getAddress()
            const t1 = await tokens[1].getAddress()
            const routerAddr = await router.getAddress()

            const traderBefore = await getBalances(await trader.getAddress())

            await expect(exactInput([w, t0, t1], 5))
              .to.emit(weth9, 'Deposit')
              .withArgs(routerAddr, 5n)

            const traderAfter = await getBalances(await trader.getAddress())
            expect(traderAfter.token1).to.eq(traderBefore.token1 + 1n)
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

            await expect(exactInput([t0, w]))
              .to.emit(weth9, 'Withdrawal')
              .withArgs(routerAddr, 1n)

            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(await trader.getAddress())

            expect(traderAfter.token0).to.eq(traderBefore.token0 - 3n)
            expect(poolAfter.weth9).to.eq(poolBefore.weth9 - 1n)
            expect(poolAfter.token0).to.eq(poolBefore.token0 + 3n)
          })

          it('0 -> 1 -> WETH9', async () => {
            const w = await weth9.getAddress()
            const t0 = await tokens[0].getAddress()
            const t1 = await tokens[1].getAddress()
            const routerAddr = await router.getAddress()

            const traderBefore = await getBalances(await trader.getAddress())

            await expect(exactInput([t0, t1, w], 5))
              .to.emit(weth9, 'Withdrawal')
              .withArgs(routerAddr, 1n)

            const traderAfter = await getBalances(await trader.getAddress())
            expect(traderAfter.token0).to.eq(traderBefore.token0 - 5n)
          })
        })
      })
    })

    describe('#exactInputSingle', () => {
      async function exactInputSingle(
        tokenIn: string,
        tokenOut: string,
        amountIn = 3,
        amountOutMinimum = 1,
        sqrtPriceLimitX96?: bigint
      ): Promise<ContractTransactionResponse> {
        const wethAddr = await weth9.getAddress()
        const traderAddr = await trader.getAddress()

        const inputIsWETH = wethAddr === tokenIn
        const outputIsWETH9 = tokenOut === wethAddr

        const value = inputIsWETH ? BigInt(amountIn) : 0n

        const params = {
          tokenIn,
          tokenOut,
          fee: FEE,
          // let the router choose the correct bound
          sqrtPriceLimitX96: sqrtPriceLimitX96 ?? 0n,
          recipient: outputIsWETH9 ? ZeroAddress : traderAddr,
          deadline: DEADLINE,
          amountIn,
          amountOutMinimum,
        }

        const data = [router.interface.encodeFunctionData('exactInputSingle', [params])]
        if (outputIsWETH9)
          data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOutMinimum, traderAddr]))

        return data.length === 1
          ? router.connect(trader).exactInputSingle(params, { value, gasLimit: 5_000_000 })
          : router.connect(trader).multicall(data, { value, gasLimit: 5_000_000 })
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

        expect(traderAfter.token0).to.eq(traderBefore.token0 - 3n)
        expect(traderAfter.token1).to.eq(traderBefore.token1 + 1n)
        expect(poolAfter.token0).to.eq(poolBefore.token0 + 3n)
        expect(poolAfter.token1).to.eq(poolBefore.token1 - 1n)
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

        expect(traderAfter.token0).to.eq(traderBefore.token0 + 1n)
        expect(traderAfter.token1).to.eq(traderBefore.token1 - 3n)
        expect(poolAfter.token0).to.eq(poolBefore.token0 - 1n)
        expect(poolAfter.token1).to.eq(poolBefore.token1 + 3n)
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
              .withArgs(routerAddr, 3n)

            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(await trader.getAddress())

            expect(traderAfter.token0).to.eq(traderBefore.token0 + 1n)
            expect(poolAfter.weth9).to.eq(poolBefore.weth9 + 3n)
            expect(poolAfter.token0).to.eq(poolBefore.token0 - 1n)
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
              .withArgs(routerAddr, 1n)

            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(await trader.getAddress())

            expect(traderAfter.token0).to.eq(traderBefore.token0 - 3n)
            expect(poolAfter.weth9).to.eq(poolBefore.weth9 - 1n)
            expect(poolAfter.token0).to.eq(poolBefore.token0 + 3n)
          })
        })
      })
    })

    describe('#exactOutput', () => {
      async function exactOutput(
        tokenAddrs: string[],
        amountOut = 1,
        amountInMaximum = 3
      ): Promise<ContractTransactionResponse> {
        const wethAddr = await weth9.getAddress()
        const traderAddr = await trader.getAddress()

        const inputIsWETH9 = tokenAddrs[0] === wethAddr
        const outputIsWETH9 = tokenAddrs[tokenAddrs.length - 1] === wethAddr

        const value = inputIsWETH9 ? BigInt(amountInMaximum) : 0n

        const params = {
          path: encodePath(tokenAddrs.slice().reverse(), new Array(tokenAddrs.length - 1).fill(FEE)),
          recipient: outputIsWETH9 ? ZeroAddress : traderAddr,
          deadline: DEADLINE,
          amountOut,
          amountInMaximum,
        }

        const data = [router.interface.encodeFunctionData('exactOutput', [params])]
        if (inputIsWETH9) data.push(router.interface.encodeFunctionData('refundETH'))
        if (outputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOut, traderAddr]))

        return router.connect(trader).multicall(data, { value, gasLimit: 5_000_000 })
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

          expect(traderAfter.token0).to.eq(traderBefore.token0 - 3n)
          expect(traderAfter.token1).to.eq(traderBefore.token1 + 1n)
          expect(poolAfter.token0).to.eq(poolBefore.token0 + 3n)
          expect(poolAfter.token1).to.eq(poolBefore.token1 - 1n)
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

          expect(traderAfter.token0).to.eq(traderBefore.token0 + 1n)
          expect(traderAfter.token1).to.eq(traderBefore.token1 - 3n)
          expect(poolAfter.token0).to.eq(poolBefore.token0 - 1n)
          expect(poolAfter.token1).to.eq(poolBefore.token1 + 3n)
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

          expect(traderAfter.token0).to.eq(traderBefore.token0 - 5n)
          expect(traderAfter.token2).to.eq(traderBefore.token2 + 1n)
        })

        it('2 -> 1 -> 0', async () => {
          const t0 = await tokens[0].getAddress()
          const t1 = await tokens[1].getAddress()
          const t2 = await tokens[2].getAddress()

          const traderBefore = await getBalances(await trader.getAddress())
          await exactOutput([t2, t1, t0], 1, 5)
          const traderAfter = await getBalances(await trader.getAddress())

          expect(traderAfter.token2).to.eq(traderBefore.token2 - 5n)
          expect(traderAfter.token0).to.eq(traderBefore.token0 + 1n)
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
              1n
            )
            .to.emit(tokens[1], 'Transfer')
            .withArgs(
              computePoolAddress(factoryAddr, [t1, t0], FEE),
              computePoolAddress(factoryAddr, [t2, t1], FEE),
              3n
            )
            .to.emit(tokens[0], 'Transfer')
            .withArgs(
              traderAddr,
              computePoolAddress(factoryAddr, [t1, t0], FEE),
              5n
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
              .withArgs(routerAddr, 3n)

            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(await trader.getAddress())

            expect(traderAfter.token0).to.eq(traderBefore.token0 + 1n)
            expect(poolAfter.weth9).to.eq(poolBefore.weth9 + 3n)
            expect(poolAfter.token0).to.eq(poolBefore.token0 - 1n)
          })

          it('WETH9 -> 0 -> 1', async () => {
            const w = await weth9.getAddress()
            const t0 = await tokens[0].getAddress()
            const t1 = await tokens[1].getAddress()
            const routerAddr = await router.getAddress()

            const traderBefore = await getBalances(await trader.getAddress())

            await expect(exactOutput([w, t0, t1], 1, 5))
              .to.emit(weth9, 'Deposit')
              .withArgs(routerAddr, 5n)

            const traderAfter = await getBalances(await trader.getAddress())
            expect(traderAfter.token1).to.eq(traderBefore.token1 + 1n)
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
              .withArgs(routerAddr, 1n)

            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(await trader.getAddress())

            expect(traderAfter.token0).to.eq(traderBefore.token0 - 3n)
            expect(poolAfter.weth9).to.eq(poolBefore.weth9 - 1n)
            expect(poolAfter.token0).to.eq(poolBefore.token0 + 3n)
          })

          it('0 -> 1 -> WETH9', async () => {
            const w = await weth9.getAddress()
            const t0 = await tokens[0].getAddress()
            const t1 = await tokens[1].getAddress()
            const routerAddr = await router.getAddress()

            const traderBefore = await getBalances(await trader.getAddress())

            await expect(exactOutput([t0, t1, w], 1, 5))
              .to.emit(weth9, 'Withdrawal')
              .withArgs(routerAddr, 1n)

            const traderAfter = await getBalances(await trader.getAddress())
            expect(traderAfter.token0).to.eq(traderBefore.token0 - 5n)
          })
        })
      })
    })
  })
})