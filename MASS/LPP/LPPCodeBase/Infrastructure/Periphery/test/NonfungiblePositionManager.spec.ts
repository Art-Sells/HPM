// test/NonfungiblePositionManager.spec.ts
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const ILPPPoolJson = require('@lpp/lpp-protocol/artifacts/contracts/interfaces/ILPPPool.sol/ILPPPool.json')
const ILPPPoolABI = ILPPPoolJson.abi
import { BigNumberish, MaxUint256, Contract, Signer } from 'ethers'
import hre from 'hardhat'
const { ethers } = hre
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'

import type {
  IWETH9,
  MockTimeNonfungiblePositionManager,
  NonfungiblePositionManagerPositionsGasTest,
  SupplicateRouter,
  TestERC20,
  TestPositionNFTOwner,
} from '../typechain-types/periphery'
import type { ILPPFactory } from '../typechain-types/protocol'

import completeFixture from './shared/completeFixture.ts'
import { computePoolAddress } from './shared/computePoolAddress.ts'
import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'
import { expandTo18Decimals } from './shared/expandTo18Decimals.ts'
import { expect } from './shared/expect.ts'
import { extractJSONFromURI } from './shared/extractJSONFromURI.ts'
import getPermitNFTSignature from './shared/getPermitNFTSignature.ts'
import { encodePath } from './shared/path.ts'
import poolAtAddress from './shared/poolAtAddress.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'
import { getMaxTick, getMinTick } from './shared/ticks.ts'
import { sortedTokens } from './shared/tokenSort.ts'

// ───────────────────────────────────────────────────────────────────────────────
// ZERO-FEE + single spacing setup
// ───────────────────────────────────────────────────────────────────────────────
const FEE = 0 // no tiers, always zero
const TICK_SPACING = 60 // one canonical spacing for tests
const MaxUint128 = (1n << 128n) - 1n

// Resolve an address from any contract-ish object (ethers v6, interface, plain with address, etc.)
async function addr(x: any): Promise<string> {
  if (typeof x === 'string') return x
  if (x?.getAddress) return x.getAddress()
  if (x?.target) return x.target as string
  if (x?.address) return x.address as string
  throw new Error('Cannot resolve address from value')
}

describe('NonfungiblePositionManager', () => {
  let wallets: Signer[]
  let wallet: Signer
  let other: Signer

  async function nftFixture() {
    // Build periphery/protocol fixture
    const signers = await ethers.getSigners()
    const { weth9, factory, tokens, nft, router } = await completeFixture(signers as any, ethers.provider)

    // Approve & fund wallets (v6-safe addresses)
    const nftAddr = await nft.getAddress()
    const otherAddr = await signers[1].getAddress()

    for (const token of tokens) {
      await token.approve(nftAddr, MaxUint256)
      await token.connect(signers[1]).approve(nftAddr, MaxUint256)
      await token.transfer(otherAddr, expandTo18Decimals(1_000_000))
    }

    return {
      nft,
      factory,
      tokens,
      weth9,
      router,
    }
  }

  before(async () => {
    wallets = await ethers.getSigners()
    ;[wallet, other] = wallets
  })

  let factory: ILPPFactory
  let nft: MockTimeNonfungiblePositionManager
  let tokens: [TestERC20, TestERC20, TestERC20]
  let weth9: IWETH9
  let router: SupplicateRouter

  beforeEach(async () => {
    ;({ nft, factory, tokens, weth9, router } = await loadFixture(nftFixture))
  })

  it('bytecode size', async () => {
    const code = await ethers.provider.getCode(await nft.getAddress())
    expect((code.length - 2) / 2).to.matchSnapshot()
  })

  describe('#createAndInitializePoolIfNecessary', () => {
    it('creates the pool at the expected address', async () => {
      const factoryAddr = await factory.getAddress()
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      const expectedAddress = computePoolAddress(factoryAddr, [token0Addr, token1Addr], FEE)

      const code = await ethers.provider.getCode(expectedAddress)
      expect(code).to.eq('0x')

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      const codeAfter = await ethers.provider.getCode(expectedAddress)
      expect(codeAfter).to.not.eq('0x')
    })

    it('is payable', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1), { value: 1 })
    })

    it('works if pool is created but not initialized', async () => {
      const factoryAddr = await factory.getAddress()
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      const expectedAddress = computePoolAddress(factoryAddr, [token0Addr, token1Addr], FEE)

      await factory.createPool(token0Addr, token1Addr, FEE)
      const code = await ethers.provider.getCode(expectedAddress)
      expect(code).to.not.eq('0x')

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(2, 1))
    })

    it('works if pool is created and initialized', async () => {
      const factoryAddr = await factory.getAddress()
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      const expectedAddress = computePoolAddress(factoryAddr, [token0Addr, token1Addr], FEE)

      await factory.createPool(token0Addr, token1Addr, FEE)
      const pool = new Contract(expectedAddress, ILPPPoolABI, wallet)
      await pool.initialize(encodePriceSqrt(3, 1))

      const code = await ethers.provider.getCode(expectedAddress)
      expect(code).to.not.eq('0x')

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(4, 1))
    })

    it('could theoretically use eth via multicall', async () => {
      const [t0, t1] = sortedTokens(weth9, tokens[0])
      const token0Addr = await addr(t0)
      const token1Addr = await addr(t1)

      const createAndInitializePoolIfNecessaryData = nft.interface.encodeFunctionData(
        'createAndInitializePoolIfNecessary',
        [token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1)]
      )

      await nft.multicall([createAndInitializePoolIfNecessaryData], { value: expandTo18Decimals(1) })
    })

    it('gas', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      await snapshotGasCost(nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1)))
    })
  })

  describe('#mint', () => {
    it('fails if pool does not exist', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await expect(
        nft.mint({
          token0: token0Addr,
          token1: token1Addr,
          tickLower: getMinTick(TICK_SPACING),
          tickUpper: getMaxTick(TICK_SPACING),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          recipient: await wallet.getAddress(),
          deadline: 1,
          fee: FEE,
        })
      ).to.be.reverted
    })

    it('fails if cannot transfer', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      const nftAddr = await nft.getAddress()
      await tokens[0].approve(nftAddr, 0)

      await expect(
        nft.mint({
          token0: token0Addr,
          token1: token1Addr,
          fee: FEE,
          tickLower: getMinTick(TICK_SPACING),
          tickUpper: getMaxTick(TICK_SPACING),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          recipient: await wallet.getAddress(),
          deadline: 1,
        })
      ).to.be.revertedWith('STF')
    })

    it('creates a token', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      const otherAddr = await other.getAddress()

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      await nft.mint({
        token0: token0Addr,
        token1: token1Addr,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        fee: FEE,
        recipient: otherAddr,
        amount0Desired: 15,
        amount1Desired: 15,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 10,
      })

      expect(await nft.balanceOf(otherAddr)).to.eq(1)
      expect(await nft.tokenOfOwnerByIndex(otherAddr, 0)).to.eq(1)

      const {
        fee,
        token0,
        token1,
        tickLower,
        tickUpper,
        liquidity,
        tokensOwed0,
        tokensOwed1,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
      } = await nft.positions(1)

      expect(token0).to.eq(token0Addr)
      expect(token1).to.eq(token1Addr)
      expect(fee).to.eq(FEE)
      expect(tickLower).to.eq(getMinTick(TICK_SPACING))
      expect(tickUpper).to.eq(getMaxTick(TICK_SPACING))
      expect(liquidity).to.eq(15)
      expect(tokensOwed0).to.eq(0)
      expect(tokensOwed1).to.eq(0)
      expect(feeGrowthInside0LastX128).to.eq(0)
      expect(feeGrowthInside1LastX128).to.eq(0)
    })

    it('can use eth via multicall', async () => {
      const [t0, t1] = sortedTokens(weth9, tokens[0])
      const token0Addr = await addr(t0)
      const token1Addr = await addr(t1)
      const otherAddr = await other.getAddress()

      // remove any approval
      const nftAddr = await nft.getAddress()
      await weth9.approve(nftAddr, 0)

      const createAndInitializeData = nft.interface.encodeFunctionData('createAndInitializePoolIfNecessary', [
        token0Addr,
        token1Addr,
        FEE,
        encodePriceSqrt(1, 1),
      ])

      const mintData = nft.interface.encodeFunctionData('mint', [
        {
          token0: token0Addr,
          token1: token1Addr,
          tickLower: getMinTick(TICK_SPACING),
          tickUpper: getMaxTick(TICK_SPACING),
          fee: FEE,
          recipient: otherAddr,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        },
      ])

      const refundETHData = nft.interface.encodeFunctionData('refundETH')

      const balanceBefore = await ethers.provider.getBalance(await wallet.getAddress())
      const tx = await nft.multicall([createAndInitializeData, mintData, refundETHData], {
        value: expandTo18Decimals(1),
      })
      const receipt = await tx.wait()
      const gasPrice = (receipt as any).effectiveGasPrice ?? tx.gasPrice ?? 0n
      const balanceAfter = await ethers.provider.getBalance(await wallet.getAddress())

      expect(balanceBefore).to.eq(balanceAfter + (receipt!.gasUsed as bigint) * (gasPrice as bigint) + 100n)
    })

    it('emits an event')

    it('gas first mint for pool', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      await snapshotGasCost(
        nft.mint({
          token0: token0Addr,
          token1: token1Addr,
          tickLower: getMinTick(TICK_SPACING),
          tickUpper: getMaxTick(TICK_SPACING),
          fee: FEE,
          recipient: await wallet.getAddress(),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      )
    })

    it('gas first mint for pool using eth with zero refund', async () => {
      const [t0, t1] = sortedTokens(weth9, tokens[0])
      const token0Addr = await addr(t0)
      const token1Addr = await addr(t1)

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      await snapshotGasCost(
        nft.multicall(
          [
            nft.interface.encodeFunctionData('mint', [
              {
                token0: token0Addr,
                token1: token1Addr,
                tickLower: getMinTick(TICK_SPACING),
                tickUpper: getMaxTick(TICK_SPACING),
                fee: FEE,
                recipient: await wallet.getAddress(),
                amount0Desired: 100,
                amount1Desired: 100,
                amount0Min: 0,
                amount1Min: 0,
                deadline: 10,
              },
            ]),
            nft.interface.encodeFunctionData('refundETH'),
          ],
          { value: 100 }
        )
      )
    })

    it('gas first mint for pool using eth with non-zero refund', async () => {
      const [t0, t1] = sortedTokens(weth9, tokens[0])
      const token0Addr = await addr(t0)
      const token1Addr = await addr(t1)

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      await snapshotGasCost(
        nft.multicall(
          [
            nft.interface.encodeFunctionData('mint', [
              {
                token0: token0Addr,
                token1: token1Addr,
                tickLower: getMinTick(TICK_SPACING),
                tickUpper: getMaxTick(TICK_SPACING),
                fee: FEE,
                recipient: await wallet.getAddress(),
                amount0Desired: 100,
                amount1Desired: 100,
                amount0Min: 0,
                amount1Min: 0,
                deadline: 10,
              },
            ]),
            nft.interface.encodeFunctionData('refundETH'),
          ],
          { value: 1000 }
        )
      )
    })

    it('gas mint on same ticks', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      await nft.mint({
        token0: token0Addr,
        token1: token1Addr,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        fee: FEE,
        recipient: await other.getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 10,
      })

      await snapshotGasCost(
        nft.mint({
          token0: token0Addr,
          token1: token1Addr,
          tickLower: getMinTick(TICK_SPACING),
          tickUpper: getMaxTick(TICK_SPACING),
          fee: FEE,
          recipient: await wallet.getAddress(),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      )
    })

    it('gas mint for same pool, different ticks', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      await nft.mint({
        token0: token0Addr,
        token1: token1Addr,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        fee: FEE,
        recipient: await other.getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 10,
      })

      await snapshotGasCost(
        nft.mint({
          token0: token0Addr,
          token1: token1Addr,
          tickLower: getMinTick(TICK_SPACING) + TICK_SPACING,
          tickUpper: getMaxTick(TICK_SPACING) - TICK_SPACING,
          fee: FEE,
          recipient: await wallet.getAddress(),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      )
    })
  })

  describe('#increaseLiquidity', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      await nft.mint({
        token0: token0Addr,
        token1: token1Addr,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        fee: FEE,
        recipient: await other.getAddress(),
        amount0Desired: 1000,
        amount1Desired: 1000,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('increases position liquidity', async () => {
      await nft.increaseLiquidity({
        tokenId: tokenId,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
      const { liquidity } = await nft.positions(tokenId)
      expect(liquidity).to.eq(1100)
    })

    it('emits an event')

    it('can be paid with ETH', async () => {
      const [a, b] = sortedTokens(tokens[0], weth9)
      const token0Addr = await addr(a)
      const token1Addr = await addr(b)
      const otherAddr = await other.getAddress()

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      const mintData = nft.interface.encodeFunctionData('mint', [
        {
          token0: token0Addr,
          token1: token1Addr,
          fee: FEE,
          tickLower: getMinTick(TICK_SPACING),
          tickUpper: getMaxTick(TICK_SPACING),
          recipient: otherAddr,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        },
      ])
      const refundETHData = nft.interface.encodeFunctionData('unwrapWETH9', [0, otherAddr])
      await nft.multicall([mintData, refundETHData], { value: expandTo18Decimals(1) })

      const increaseLiquidityData = nft.interface.encodeFunctionData('increaseLiquidity', [
        {
          tokenId: 1,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        },
      ])
      await nft.multicall([increaseLiquidityData, refundETHData], { value: expandTo18Decimals(1) })
    })

    it('gas', async () => {
      await snapshotGasCost(
        nft.increaseLiquidity({
          tokenId: tokenId,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        })
      )
    })
  })

  describe('#decreaseLiquidity', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      await nft.mint({
        token0: token0Addr,
        token1: token1Addr,
        fee: FEE,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        recipient: await other.getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('emits an event')

    it('fails if past deadline', async () => {
      await nft.setTime(2)
      await expect(
        nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.revertedWith('Transaction too old')
    })

    it('cannot be called by other addresses', async () => {
      await expect(
        nft.decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.revertedWith('Not approved')
    })

    it('decreases position liquidity', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 25, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const { liquidity } = await nft.positions(tokenId)
      expect(liquidity).to.eq(75)
    })

    it('is payable', async () => {
      await nft
        .connect(other)
        .decreaseLiquidity({ tokenId, liquidity: 25, amount0Min: 0, amount1Min: 0, deadline: 1 }, { value: 1 })
    })

    it('accounts for tokens owed', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 25, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const { tokensOwed0, tokensOwed1 } = await nft.positions(tokenId)
      expect(tokensOwed0).to.eq(24)
      expect(tokensOwed1).to.eq(24)
    })

    it('can decrease for all the liquidity', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const { liquidity } = await nft.positions(tokenId)
      expect(liquidity).to.eq(0)
    })

    it('cannot decrease for more than all the liquidity', async () => {
      await expect(
        nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 101, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.reverted
    })

    it('cannot decrease for more than the liquidity of the nft position', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      await nft.mint({
        token0: token0Addr,
        token1: token1Addr,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        fee: FEE,
        recipient: await other.getAddress(),
        amount0Desired: 200,
        amount1Desired: 200,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
      await expect(
        nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 101, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.reverted
    })

    it('gas partial decrease', async () => {
      await snapshotGasCost(
        nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      )
    })

    it('gas complete decrease', async () => {
      await snapshotGasCost(
        nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      )
    })
  })

  describe('#collect', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      await nft.mint({
        token0: token0Addr,
        token1: token1Addr,
        fee: FEE,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        recipient: await other.getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('emits an event')

    it('cannot be called by other addresses', async () => {
      await expect(
        nft.collect({
          tokenId,
          recipient: await wallet.getAddress(),
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
      ).to.be.revertedWith('Not approved')
    })

    it('cannot be called with 0 for both amounts', async () => {
      await expect(
        nft.connect(other).collect({
          tokenId,
          recipient: await wallet.getAddress(),
          amount0Max: 0,
          amount1Max: 0,
        })
      ).to.be.reverted
    })

    it('no op if no tokens are owed', async () => {
      await expect(
        nft.connect(other).collect({
          tokenId,
          recipient: await wallet.getAddress(),
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
      )
        .to.not.emit(tokens[0], 'Transfer')
        .to.not.emit(tokens[1], 'Transfer')
    })

    it('transfers tokens owed from burn', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const factoryAddr = await factory.getAddress()
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      const poolAddress = computePoolAddress(factoryAddr, [token0Addr, token1Addr], FEE)

      await expect(
        nft.connect(other).collect({
          tokenId,
          recipient: await wallet.getAddress(),
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
      )
        .to.emit(tokens[0], 'Transfer')
        .withArgs(poolAddress, await wallet.getAddress(), 49)
        .to.emit(tokens[1], 'Transfer')
        .withArgs(poolAddress, await wallet.getAddress(), 49)
    })

    it('gas transfers both', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await snapshotGasCost(
        nft.connect(other).collect({
          tokenId,
          recipient: await wallet.getAddress(),
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
      )
    })

    it('gas transfers token0 only', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await snapshotGasCost(
        nft.connect(other).collect({
          tokenId,
          recipient: await wallet.getAddress(),
          amount0Max: MaxUint128,
          amount1Max: 0,
        })
      )
    })

    it('gas transfers token1 only', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await snapshotGasCost(
        nft.connect(other).collect({
          tokenId,
          recipient: await wallet.getAddress(),
          amount0Max: 0,
          amount1Max: MaxUint128,
        })
      )
    })
  })

  describe('#burn', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      await nft.mint({
        token0: token0Addr,
        token1: token1Addr,
        fee: FEE,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        recipient: await other.getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('emits an event')

    it('cannot be called by other addresses', async () => {
      await expect(nft.burn(tokenId)).to.be.revertedWith('Not approved')
    })

    it('cannot be called while there is still liquidity', async () => {
      await expect(nft.connect(other).burn(tokenId)).to.be.revertedWith('Not cleared')
    })

    it('cannot be called while there is still partial liquidity', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await expect(nft.connect(other).burn(tokenId)).to.be.revertedWith('Not cleared')
    })

    it('cannot be called while there is still tokens owed', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await expect(nft.connect(other).burn(tokenId)).to.be.revertedWith('Not cleared')
    })

    it('deletes the token', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await nft.connect(other).collect({
        tokenId,
        recipient: await wallet.getAddress(),
        amount0Max: MaxUint128,
        amount1Max: MaxUint128,
      })
      await nft.connect(other).burn(tokenId)
      await expect(nft.positions(tokenId)).to.be.revertedWith('Invalid token ID')
    })

    it('gas', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await nft.connect(other).collect({
        tokenId,
        recipient: await wallet.getAddress(),
        amount0Max: MaxUint128,
        amount1Max: MaxUint128,
      })
      await snapshotGasCost(nft.connect(other).burn(tokenId))
    })
  })

  describe('#transferFrom', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      await nft.mint({
        token0: token0Addr,
        token1: token1Addr,
        fee: FEE,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        recipient: await other.getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('can only be called by authorized or owner', async () => {
      await expect(nft.transferFrom(await other.getAddress(), await wallet.getAddress(), tokenId)).to.be.revertedWith(
        'ERC721: transfer caller is not owner nor approved'
      )
    })

    it('changes the owner', async () => {
      await nft.connect(other).transferFrom(await other.getAddress(), await wallet.getAddress(), tokenId)
      expect(await nft.ownerOf(tokenId)).to.eq(await wallet.getAddress())
    })

    it('removes existing approval', async () => {
      await nft.connect(other).approve(await wallet.getAddress(), tokenId)
      expect(await nft.getApproved(tokenId)).to.eq(await wallet.getAddress())
      await nft.transferFrom(await other.getAddress(), await wallet.getAddress(), tokenId)
      expect(await nft.getApproved(tokenId)).to.eq('0x0000000000000000000000000000000000000000')
    })

    it('gas', async () => {
      await snapshotGasCost(nft.connect(other).transferFrom(await other.getAddress(), await wallet.getAddress(), tokenId))
    })

    it('gas comes from approved', async () => {
      await nft.connect(other).approve(await wallet.getAddress(), tokenId)
      await snapshotGasCost(nft.transferFrom(await other.getAddress(), await wallet.getAddress(), tokenId))
    })
  })

  describe('#permit', () => {
    it('emits an event')

    describe('owned by eoa', () => {
      const tokenId = 1
      beforeEach('create a position', async () => {
        const token0Addr = await tokens[0].getAddress()
        const token1Addr = await tokens[1].getAddress()

        await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

        await nft.mint({
          token0: token0Addr,
          token1: token1Addr,
          fee: FEE,
          tickLower: getMinTick(TICK_SPACING),
          tickUpper: getMaxTick(TICK_SPACING),
          recipient: await other.getAddress(),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        })
      })

      it('changes the operator of the position and increments the nonce', async () => {
        const tokenId = 1
        const sig = await getPermitNFTSignature(other as any, nft, await wallet.getAddress(), tokenId, 1)
        await nft.permit(await wallet.getAddress(), tokenId, 1, sig.v, sig.r, sig.s)
        expect((await nft.positions(tokenId)).nonce).to.eq(1)
        expect((await nft.positions(tokenId)).operator).to.eq(await wallet.getAddress())
      })

      it('cannot be called twice with the same signature', async () => {
        const tokenId = 1
        const sig = await getPermitNFTSignature(other as any, nft, await wallet.getAddress(), tokenId, 1)
        await nft.permit(await wallet.getAddress(), tokenId, 1, sig.v, sig.r, sig.s)
        await expect(nft.permit(await wallet.getAddress(), tokenId, 1, sig.v, sig.r, sig.s)).to.be.reverted
      })

      it('fails with invalid signature', async () => {
        const tokenId = 1
        const sig = await getPermitNFTSignature(wallet as any, nft, await wallet.getAddress(), tokenId, 1)
        await expect(nft.permit(await wallet.getAddress(), tokenId, 1, (sig.v as number) + 3, sig.r, sig.s)).to.be
          .revertedWith('Invalid signature')
      })

      it('fails with signature not from owner', async () => {
        const tokenId = 1
        const sig = await getPermitNFTSignature(wallet as any, nft, await wallet.getAddress(), tokenId, 1)
        await expect(nft.permit(await wallet.getAddress(), tokenId, 1, sig.v, sig.r, sig.s)).to.be.revertedWith(
          'Unauthorized'
        )
      })

      it('fails with expired signature', async () => {
        await nft.setTime(2)
        const tokenId = 1
        const sig = await getPermitNFTSignature(other as any, nft, await wallet.getAddress(), tokenId, 1)
        await expect(nft.permit(await wallet.getAddress(), tokenId, 1, sig.v, sig.r, sig.s)).to.be.revertedWith(
          'Permit expired'
        )
      })

      it('gas', async () => {
        const tokenId = 1
        const sig = await getPermitNFTSignature(other as any, nft, await wallet.getAddress(), tokenId, 1)
        await snapshotGasCost(nft.permit(await wallet.getAddress(), tokenId, 1, sig.v, sig.r, sig.s))
      })
    })

    describe('owned by verifying contract', () => {
      const tokenId = 1
      let testPositionNFTOwner: TestPositionNFTOwner

      beforeEach('deploy test owner and create a position', async () => {
        const fac = await ethers.getContractFactory('TestPositionNFTOwner')
        const deployed = await fac.deploy()
        await deployed.waitForDeployment()
        testPositionNFTOwner = deployed as unknown as TestPositionNFTOwner

        const token0Addr = await tokens[0].getAddress()
        const token1Addr = await tokens[1].getAddress()

        await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

        await nft.mint({
          token0: token0Addr,
          token1: token1Addr,
          fee: FEE,
          tickLower: getMinTick(TICK_SPACING),
          tickUpper: getMaxTick(TICK_SPACING),
          recipient: await testPositionNFTOwner.getAddress(),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        })
      })

      it('changes the operator of the position and increments the nonce', async () => {
        const sig = await getPermitNFTSignature(other as any, nft, await wallet.getAddress(), tokenId, 1)
        await testPositionNFTOwner.setOwner(await other.getAddress())
        await nft.permit(await wallet.getAddress(), tokenId, 1, sig.v, sig.r, sig.s)
        expect((await nft.positions(tokenId)).nonce).to.eq(1)
        expect((await nft.positions(tokenId)).operator).to.eq(await wallet.getAddress())
      })

      it('fails if owner contract is owned by different address', async () => {
        const sig = await getPermitNFTSignature(other as any, nft, await wallet.getAddress(), tokenId, 1)
        await testPositionNFTOwner.setOwner(await wallet.getAddress())
        await expect(nft.permit(await wallet.getAddress(), tokenId, 1, sig.v, sig.r, sig.s)).to.be.revertedWith(
          'Unauthorized'
        )
      })

      it('fails with signature not from owner', async () => {
        const sig = await getPermitNFTSignature(wallet as any, nft, await wallet.getAddress(), tokenId, 1)
        await testPositionNFTOwner.setOwner(await other.getAddress())
        await expect(nft.permit(await wallet.getAddress(), tokenId, 1, sig.v, sig.r, sig.s)).to.be.revertedWith(
          'Unauthorized'
        )
      })

      it('fails with expired signature', async () => {
        await nft.setTime(2)
        const sig = await getPermitNFTSignature(other as any, nft, await wallet.getAddress(), tokenId, 1)
        await testPositionNFTOwner.setOwner(await other.getAddress())
        await expect(nft.permit(await wallet.getAddress(), tokenId, 1, sig.v, sig.r, sig.s)).to.be.revertedWith(
          'Permit expired'
        )
      })

      it('gas', async () => {
        const sig = await getPermitNFTSignature(other as any, nft, await wallet.getAddress(), tokenId, 1)
        await testPositionNFTOwner.setOwner(await other.getAddress())
        await snapshotGasCost(nft.permit(await wallet.getAddress(), tokenId, 1, sig.v, sig.r, sig.s))
      })
    })
  })

  describe('multicall exit', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      await nft.mint({
        token0: token0Addr,
        token1: token1Addr,
        fee: FEE,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        recipient: await other.getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    async function exit({
      nft,
      liquidity,
      tokenId,
      amount0Min,
      amount1Min,
      recipient,
    }: {
      nft: MockTimeNonfungiblePositionManager
      tokenId: BigNumberish
      liquidity: BigNumberish
      amount0Min: BigNumberish
      amount1Min: BigNumberish
      recipient: string
    }) {
      const decreaseLiquidityData = nft.interface.encodeFunctionData('decreaseLiquidity', [
        { tokenId, liquidity, amount0Min, amount1Min, deadline: 1 },
      ])
      const collectData = nft.interface.encodeFunctionData('collect', [
        { tokenId, recipient, amount0Max: MaxUint128, amount1Max: MaxUint128 },
      ])
      const burnData = nft.interface.encodeFunctionData('burn', [tokenId])
      return nft.multicall([decreaseLiquidityData, collectData, burnData])
    }

    it('executes all the actions', async () => {
      const factoryAddr = await factory.getAddress()
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      const pool = poolAtAddress(computePoolAddress(factoryAddr, [token0Addr, token1Addr], FEE), wallet)

      await expect(
        exit({
          nft: nft.connect(other),
          tokenId,
          liquidity: 100,
          amount0Min: 0,
          amount1Min: 0,
          recipient: await wallet.getAddress(),
        })
      )
        .to.emit(pool, 'Burn')
        .to.emit(pool, 'Collect')
    })

    it('gas', async () => {
      await snapshotGasCost(
        exit({
          nft: nft.connect(other),
          tokenId,
          liquidity: 100,
          amount0Min: 0,
          amount1Min: 0,
          recipient: await wallet.getAddress(),
        })
      )
    })
  })

  describe('#tokenURI', async () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      await nft.mint({
        token0: token0Addr,
        token1: token1Addr,
        fee: FEE,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        recipient: await other.getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('reverts for invalid token id', async () => {
      await expect(nft.tokenURI(tokenId + 1)).to.be.reverted
    })

    it('returns a data URI with correct mime type', async () => {
      expect(await nft.tokenURI(tokenId)).to.match(/data:application\/json;base64,.+/)
    })

    it('content is valid JSON and structure', async () => {
      const content = extractJSONFromURI(await nft.tokenURI(tokenId))
      expect(content).to.haveOwnProperty('name').is.a('string')
      expect(content).to.haveOwnProperty('description').is.a('string')
      expect(content).to.haveOwnProperty('image').is.a('string')
    })
  })

  describe('#positions', async () => {
    it('gas', async () => {
      const positionsGasTestFactory = await ethers.getContractFactory('NonfungiblePositionManagerPositionsGasTest')
      const positionsGasTest = (await positionsGasTestFactory.deploy(
        await nft.getAddress()
      )) as unknown as NonfungiblePositionManagerPositionsGasTest

      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await nft.createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))

      await nft.mint({
        token0: token0Addr,
        token1: token1Addr,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        fee: FEE,
        recipient: await other.getAddress(),
        amount0Desired: 15,
        amount1Desired: 15,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 10,
      })

      await snapshotGasCost(positionsGasTest.getGasCostOfPositions(1))
    })
  })
})