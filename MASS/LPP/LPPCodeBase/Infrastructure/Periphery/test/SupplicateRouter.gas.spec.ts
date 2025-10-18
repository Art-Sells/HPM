// test/SupplicateRouter.gas.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const ILPPPoolJson = require('@lpp/lpp-protocol/artifacts/contracts/interfaces/ILPPPool.sol/ILPPPool.json')
const ILPPPoolABI = ILPPPoolJson.abi

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { MaxUint256, ZeroAddress, Contract, ContractTransactionResponse } from 'ethers'

import type {
  IWETH9,
  MockTimeSupplicateRouter,
  TestERC20,
  TestLPPCallee,
} from '../typechain-types/periphery'
import type { ILPPPool } from '../typechain-types/protocol'

import completeFixture from './shared/completeFixture.ts'
import { FeeAmount, TICK_SPACINGS } from './shared/constants.ts'
import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'
import { expandTo18Decimals } from './shared/expandTo18Decimals.ts'
import { expect } from './shared/expect.ts'
import { encodePath } from './shared/path.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'
import { getMaxTick, getMinTick } from './shared/ticks.ts'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'

describe('SupplicateRouter gas tests', function () {
  this.timeout(40000)

  let wallet: HardhatEthersSigner
  let trader: HardhatEthersSigner

  const FEE = FeeAmount.ZERO

  async function swapRouterFixture() {
    // the helper expects (wallets, provider)
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

    // pool helpers
    async function createPool(tokenAddressA: string, tokenAddressB: string) {
      let a = tokenAddressA
      let b = tokenAddressB
      if (a.toLowerCase() > b.toLowerCase()) [a, b] = [b, a]

      await nft.createAndInitializePoolIfNecessary(
        a,
        b,
        FEE,
        encodePriceSqrt(100005, 100000) // we don't want to cross any ticks
      )

      const walletAddr = await wallet.getAddress()
      const liquidityParams = {
        token0: a,
        token1: b,
        fee: FEE,
        tickLower: getMinTick(TICK_SPACINGS[FEE]),
        tickUpper: getMaxTick(TICK_SPACINGS[FEE]),
        recipient: walletAddr,
        amount0Desired: 1_000_000,
        amount1Desired: 1_000_000,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      }

      return nft.mint(liquidityParams)
    }

    async function createPoolWETH9(tokenAddress: string) {
      await weth9.deposit({ value: 2_000_000 })
      await weth9.approve(nftAddr, MaxUint256)
      return createPool(await weth9.getAddress(), tokenAddress)
    }

    // create pools
    const t0 = await tokens[0].getAddress()
    const t1 = await tokens[1].getAddress()
    const t2 = await tokens[2].getAddress()
    const wethAddr = await weth9.getAddress()

    await createPool(t0, t1)
    await createPool(t1, t2)
    await createPoolWETH9(t0)

    const poolAddresses = (await Promise.all([
      factory.getPool(t0, t1, FEE),
      factory.getPool(t1, t2, FEE),
      factory.getPool(wethAddr, t0, FEE),
    ])) as [string, string, string]

    const pools = poolAddresses.map(
      (poolAddress) => new Contract(poolAddress, ILPPPoolABI, wallet)
    ) as unknown as [ILPPPool, ILPPPool, ILPPPool]

    return {
      weth9,
      router,
      tokens,
      pools,
    }
  }

  let weth9: IWETH9
  let router: MockTimeSupplicateRouter
  let tokens: [TestERC20, TestERC20, TestERC20]
  let pools: [ILPPPool, ILPPPool, ILPPPool]

  beforeEach('load fixture', async () => {
    ;({ router, weth9, tokens, pools } = await loadFixture(swapRouterFixture))
  })

  async function exactInput(
    tokenAddrs: string[],
    amountIn = 2,
    amountOutMinimum = 1
  ): Promise<ContractTransactionResponse> {
    const wethAddr = await weth9.getAddress()
    const traderAddr = await trader.getAddress()

    const inputIsWETH = wethAddr === tokenAddrs[0]
    const outputIsWETH9 = tokenAddrs[tokenAddrs.length - 1] === wethAddr

    const value = inputIsWETH ? amountIn : 0

    const params = {
      path: encodePath(tokenAddrs, new Array(tokenAddrs.length - 1).fill(FEE)),
      recipient: outputIsWETH9 ? ZeroAddress : traderAddr,
      deadline: 1,
      amountIn,
      amountOutMinimum: outputIsWETH9 ? 0 : amountOutMinimum, // save on calldata,
    }

    const data = [router.interface.encodeFunctionData('exactInput', [params])]
    if (outputIsWETH9)
      data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOutMinimum, traderAddr]))

    return data.length === 1
      ? router.connect(trader).exactInput(params, { value })
      : router.connect(trader).multicall(data, { value })
  }

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

    const value = inputIsWETH ? amountIn : 0

    const params = {
      tokenIn,
      tokenOut,
      fee: FEE,
      sqrtPriceLimitX96: sqrtPriceLimitX96 ?? 0n,
      recipient: outputIsWETH9 ? ZeroAddress : traderAddr,
      deadline: 1,
      amountIn,
      amountOutMinimum: outputIsWETH9 ? 0 : amountOutMinimum, // save on calldata
    }

    const data = [router.interface.encodeFunctionData('exactInputSingle', [params])]
    if (outputIsWETH9)
      data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOutMinimum, traderAddr]))

    return data.length === 1
      ? router.connect(trader).exactInputSingle(params, { value })
      : router.connect(trader).multicall(data, { value })
  }

  async function exactOutput(tokenAddrs: string[]): Promise<ContractTransactionResponse> {
    const wethAddr = await weth9.getAddress()
    const traderAddr = await trader.getAddress()

    const amountInMaximum = 10
    const amountOut = 1

    const inputIsWETH9 = tokenAddrs[0] === wethAddr
    const outputIsWETH9 = tokenAddrs[tokenAddrs.length - 1] === wethAddr

    const value = inputIsWETH9 ? amountInMaximum : 0

    const params = {
      path: encodePath(tokenAddrs.slice().reverse(), new Array(tokenAddrs.length - 1).fill(FEE)),
      recipient: outputIsWETH9 ? ZeroAddress : traderAddr,
      deadline: 1,
      amountOut,
      amountInMaximum,
    }

    const data = [router.interface.encodeFunctionData('exactOutput', [params])]
    if (inputIsWETH9) data.push(router.interface.encodeFunctionData('refundETH'))
    if (outputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOut, traderAddr]))

    return router.connect(trader).multicall(data, { value })
  }

  async function exactOutputSingle(
    tokenIn: string,
    tokenOut: string,
    amountOut = 1,
    amountInMaximum = 3,
    sqrtPriceLimitX96?: bigint
  ): Promise<ContractTransactionResponse> {
    const wethAddr = await weth9.getAddress()
    const traderAddr = await trader.getAddress()

    const inputIsWETH9 = tokenIn === wethAddr
    const outputIsWETH9 = tokenOut === wethAddr

    const value = inputIsWETH9 ? amountInMaximum : 0

    const params = {
      tokenIn,
      tokenOut,
      fee: FEE,
      recipient: outputIsWETH9 ? ZeroAddress : traderAddr,
      deadline: 1,
      amountOut,
      amountInMaximum,
      sqrtPriceLimitX96: sqrtPriceLimitX96 ?? 0n,
    }

    const data = [router.interface.encodeFunctionData('exactOutputSingle', [params])]
    if (inputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [0, traderAddr]))
    if (outputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOut, traderAddr]))

    return router.connect(trader).multicall(data, { value })
  }

  // initialize feeGrowthGlobals a bit
  beforeEach('intialize feeGrowthGlobals', async () => {
    await exactInput([await tokens[0].getAddress(), await tokens[1].getAddress()], 1, 0)
    await exactInput([await tokens[1].getAddress(), await tokens[0].getAddress()], 1, 0)
    await exactInput([await tokens[1].getAddress(), await tokens[2].getAddress()], 1, 0)
    await exactInput([await tokens[2].getAddress(), await tokens[1].getAddress()], 1, 0)
    await exactInput([await tokens[0].getAddress(), await weth9.getAddress()], 1, 0)
    await exactInput([await weth9.getAddress(), await tokens[0].getAddress()], 1, 0)
  })

    beforeEach('ensure feeGrowthGlobals reflect 0 bps pools', async () => {
      const slots = await Promise.all(
        pools.map((pool) =>
          Promise.all([
            pool.feeGrowthGlobal0X128().then((f: bigint) => f.toString()),
            pool.feeGrowthGlobal1X128().then((f: bigint) => f.toString()),
          ])
        )
      )

      for (const [g0, g1] of slots) {
        expect(BigInt(g0)).to.equal(0n)
        expect(BigInt(g1)).to.equal(0n)
      }
    })

  beforeEach('ensure ticks are 0 before', async () => {
    const slots = await Promise.all(pools.map((pool) => pool.slot0().then(({ tick }) => tick)))
    expect(slots).to.deep.eq([0, 0, 0])
  })

  afterEach('ensure ticks are 0 after', async () => {
    const slots = await Promise.all(pools.map((pool) => pool.slot0().then(({ tick }) => tick)))
    expect(slots).to.deep.eq([0, 0, 0])
  })

  describe('#exactInput', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(
        exactInput([await tokens[0].getAddress(), await tokens[1].getAddress()])
      )
    })

    it('0 -> 1 minimal', async () => {
      const calleeFactory = await ethers.getContractFactory('TestLPPCallee')
      const callee = (await calleeFactory.deploy()) as unknown as TestLPPCallee
      await callee.waitForDeployment()

      const calleeAddr = await callee.getAddress()
      const traderAddr = await trader.getAddress()

      await tokens[0].connect(trader).approve(calleeAddr, MaxUint256)

      await snapshotGasCost(
        callee
          .connect(trader)
          .swapExact0For1(await pools[0].getAddress(), 2, traderAddr, 4295128740n)
      )
    })

    it('0 -> 1 -> 2', async () => {
      await snapshotGasCost(
        exactInput(
          [await tokens[0].getAddress(), await tokens[1].getAddress(), await tokens[2].getAddress()],
          3
        )
      )
    })

    it('WETH9 -> 0', async () => {
      const w = await weth9.getAddress()
      const t0 = await tokens[0].getAddress()
      await snapshotGasCost(
        exactInput(
          [w, t0],
          w.toLowerCase() < t0.toLowerCase() ? 2 : 3
        )
      )
    })

    it('0 -> WETH9', async () => {
      const w = await weth9.getAddress()
      const t0 = await tokens[0].getAddress()
      await snapshotGasCost(
        exactInput(
          [t0, w],
          t0.toLowerCase() < w.toLowerCase() ? 2 : 3
        )
      )
    })

    it('2 trades (via router)', async () => {
      await weth9.connect(trader).deposit({ value: 3 })
      await weth9.connect(trader).approve(await router.getAddress(), MaxUint256)

      const swap0 = {
        path: encodePath([await weth9.getAddress(), await tokens[0].getAddress()], [FEE]),
        recipient: ZeroAddress,
        deadline: 1,
        amountIn: 3,
        amountOutMinimum: 0,
      }

      const swap1 = {
        path: encodePath([await tokens[1].getAddress(), await tokens[0].getAddress()], [FEE]),
        recipient: ZeroAddress,
        deadline: 1,
        amountIn: 3,
        amountOutMinimum: 0,
      }

      const data = [
        router.interface.encodeFunctionData('exactInput', [swap0]),
        router.interface.encodeFunctionData('exactInput', [swap1]),
        router.interface.encodeFunctionData('sweepToken', [await tokens[0].getAddress(), 2, await trader.getAddress()]),
      ]

      await snapshotGasCost(router.connect(trader).multicall(data))
    })

    it('3 trades (directly to sender)', async () => {
      await weth9.connect(trader).deposit({ value: 3 })
      await weth9.connect(trader).approve(await router.getAddress(), MaxUint256)
      const traderAddr = await trader.getAddress()

      const swap0 = {
        path: encodePath([await weth9.getAddress(), await tokens[0].getAddress()], [FEE]),
        recipient: traderAddr,
        deadline: 1,
        amountIn: 3,
        amountOutMinimum: 1,
      }

      const swap1 = {
        path: encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FEE]),
        recipient: traderAddr,
        deadline: 1,
        amountIn: 3,
        amountOutMinimum: 1,
      }

      const swap2 = {
        path: encodePath([await tokens[1].getAddress(), await tokens[2].getAddress()], [FEE]),
        recipient: traderAddr,
        deadline: 1,
        amountIn: 3,
        amountOutMinimum: 1,
      }

      const data = [
        router.interface.encodeFunctionData('exactInput', [swap0]),
        router.interface.encodeFunctionData('exactInput', [swap1]),
        router.interface.encodeFunctionData('exactInput', [swap2]),
      ]

      await snapshotGasCost(router.connect(trader).multicall(data))
    })
  })

  it('3 trades (directly to sender)', async () => {
    await weth9.connect(trader).deposit({ value: 3 })
    await weth9.connect(trader).approve(await router.getAddress(), MaxUint256)
    const traderAddr = await trader.getAddress()

    const swap0 = {
      path: encodePath([await weth9.getAddress(), await tokens[0].getAddress()], [FEE]),
      recipient: traderAddr,
      deadline: 1,
      amountIn: 3,
      amountOutMinimum: 1,
    }

    const swap1 = {
      path: encodePath([await tokens[1].getAddress(), await tokens[0].getAddress()], [FEE]),
      recipient: traderAddr,
      deadline: 1,
      amountIn: 3,
      amountOutMinimum: 1,
    }

    const data = [
      router.interface.encodeFunctionData('exactInput', [swap0]),
      router.interface.encodeFunctionData('exactInput', [swap1]),
    ]

    await snapshotGasCost(router.connect(trader).multicall(data))
  })

  describe('#exactInputSingle', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(exactInputSingle(await tokens[0].getAddress(), await tokens[1].getAddress()))
    })

    it('WETH9 -> 0', async () => {
      const w = await weth9.getAddress()
      const t0 = await tokens[0].getAddress()
      await snapshotGasCost(
        exactInputSingle(
          w,
          t0,
          w.toLowerCase() < t0.toLowerCase() ? 2 : 3
        )
      )
    })

    it('0 -> WETH9', async () => {
      const w = await weth9.getAddress()
      const t0 = await tokens[0].getAddress()
      await snapshotGasCost(
        exactInputSingle(
          t0,
          w,
          t0.toLowerCase() < w.toLowerCase() ? 2 : 3
        )
      )
    })
  })

  describe('#exactOutput', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(exactOutput([await tokens[0].getAddress(), await tokens[1].getAddress()]))
    })

    it('0 -> 1 -> 2', async () => {
      await snapshotGasCost(
        exactOutput([await tokens[0].getAddress(), await tokens[1].getAddress(), await tokens[2].getAddress()])
      )
    })

    it('WETH9 -> 0', async () => {
      await snapshotGasCost(exactOutput([await weth9.getAddress(), await tokens[0].getAddress()]))
    })

    it('0 -> WETH9', async () => {
      await snapshotGasCost(exactOutput([await tokens[0].getAddress(), await weth9.getAddress()]))
    })
  })

  describe('#exactOutputSingle', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(exactOutputSingle(await tokens[0].getAddress(), await tokens[1].getAddress()))
    })

    it('WETH9 -> 0', async () => {
      await snapshotGasCost(exactOutputSingle(await weth9.getAddress(), await tokens[0].getAddress()))
    })

    it('0 -> WETH9', async () => {
      await snapshotGasCost(exactOutputSingle(await tokens[0].getAddress(), await weth9.getAddress()))
    })
  })
})