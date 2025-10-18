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

  // helper to create pool with zero-fee tier (WAIT for txs to mine)
  async function createPool(tokenAddressA: string, tokenAddressB: string) {
    let a = tokenAddressA
    let b = tokenAddressB
    if (a.toLowerCase() > b.toLowerCase()) [a, b] = [b, a]

    const tx1 = await nft.createAndInitializePoolIfNecessary(a, b, FEE, encodePriceSqrt(1, 1))
    await tx1.wait()
    const spacing = TICK_SPACINGS[FEE]

    const recipient = await wallet.getAddress()
    const liquidityParams = {
      token0: a,
      token1: b,
      fee: FEE,
tickLower: -100 * spacing,
tickUpper:  100 * spacing,
      recipient,
      amount0Desired: liquidity,
      amount1Desired: liquidity,
      amount0Min: 0,
      amount1Min: 0,
      deadline: 1, // mint helper uses 1; fine for local fixture
    }

    const tx2 = await nft.mint(liquidityParams)
    await tx2.wait()
  }

  async function createPoolWETH9(tokenAddress: string) {
    const nftAddr = await nft.getAddress()
    const txD = await weth9.deposit({ value: BigInt(liquidity) })
    await txD.wait()
    const txA = await weth9.approve(nftAddr, MaxUint256)
    await txA.wait()
    return createPool(await weth9.getAddress(), tokenAddress)
  }

  beforeEach('load fixture', async () => {
    const fix = await loadFixture(swapRouterFixture)
    router  = fix.router
    weth9   = fix.weth9
    factory = fix.factory
    tokens  = fix.tokens
    nft     = fix.nft

    // normalize indices so tokens[0] < tokens[1] < tokens[2] by address
    const list = await Promise.all(
      tokens.map(async (t) => ({ t, addr: (await t.getAddress()).toLowerCase() }))
    )
    list.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
    tokens = [list[0].t, list[1].t, list[2].t] as unknown as [TestERC20, TestERC20, TestERC20]

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
    const t0 = await tokens[0].getAddress()
    const t1 = await tokens[1].getAddress()
    const t2 = await tokens[2].getAddress()
    await createPool(t0, t1)
    await createPool(t1, t2)
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
        const wethAddr = await weth9.getAddress()
        const traderAddr = await trader.getAddress()

        const inputIsWETH = addrEq(wethAddr, tokenAddrs[0])
        const outputIsWETH9 = addrEq(tokenAddrs[tokenAddrs.length - 1], wethAddr)

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

        // sanity: force a revert with absurd min
        const _origMin = params.amountOutMinimum
        params.amountOutMinimum = 1_000_000_000
        await expect(router.connect(trader).exactInput(params, { value })).to.be.reverted
        params.amountOutMinimum = _origMin


const tx = data.length === 1
  ? await router.connect(trader).exactInput(params, { value })
  : await router.connect(trader).multicall(data, { value })
await tx.wait()
return tx
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

      // describe('multi-pool', () => {
      //   ...
      // })

      // describe('ETH input', () => {
      //   ...
      // })

      // describe('ETH output', () => {
      //   ...
      // })
    })

    //
    // ────────────────────────────────────────────────────────────────────
    //  #exactInputSingle
    // ────────────────────────────────────────────────────────────────────
    //
    // describe('#exactInputSingle', () => {
    //   ...
    // })

    //
    // ────────────────────────────────────────────────────────────────────
    //  #exactOutput
    // ────────────────────────────────────────────────────────────────────
    //
    // describe('#exactOutput', () => {
    //   ...
    // })

    // // ────────────────────────────────────────────────────────────────────
    // //  #exactOutputSingle
    // // ────────────────────────────────────────────────────────────────────
    // describe('#exactOutputSingle', () => {
    //   ...
    // })
  })
})