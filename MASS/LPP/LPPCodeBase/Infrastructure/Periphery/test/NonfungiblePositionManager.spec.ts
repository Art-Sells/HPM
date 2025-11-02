// test/NonfungiblePositionManager.spec.ts

import type { BigNumberish, Signer } from 'ethers'
import { MaxUint256, Contract } from 'ethers'
import hre from 'hardhat'
const { ethers, artifacts } = hre
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'

import type {
  IWETH9,
  LPPMintHook,
  MockTimeNonfungiblePositionManager,
  NonfungiblePositionManagerPositionsGasTest,
  SupplicateRouter,
  TestERC20,
  TestPositionNFTOwner,
} from '../typechain-types/periphery'
import type { ILPPFactory } from '../typechain-types/protocol'

import completeFixture from './shared/completeFixture.ts'
import { computeExpectedPool } from './shared/poolAddressLib.ts'
import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'
import { expandTo18Decimals } from './shared/expandTo18Decimals.ts'
import { expect } from './shared/expect.ts'
import { extractJSONFromURI } from './shared/extractJSONFromURI.ts'
import getPermitNFTSignature from './shared/getPermitNFTSignature.ts'
import poolAtAddress from './shared/poolAtAddress.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'
import { getMaxTick, getMinTick } from './shared/ticks.ts'
import { sortedTokens } from './shared/tokenSort.ts'

// ───────────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────────
type MintParams = {
  token0: string
  token1: string
  fee: number
  tickLower: number
  tickUpper: number
  recipient: string
  amount0Desired: BigNumberish
  amount1Desired: BigNumberish
  amount0Min: BigNumberish
  amount1Min: BigNumberish
  deadline: BigNumberish
}

type IncParams = {
  tokenId: BigNumberish
  amount0Desired: BigNumberish
  amount1Desired: BigNumberish
  amount0Min: BigNumberish
  amount1Min: BigNumberish
  deadline: BigNumberish
}

// ───────────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────────
const FEE = 0
const TICK_SPACING = 60
const MaxUint128 = (1n << 128n) - 1n

// ───────────────────────────────────────────────────────────────────────────────
// ABI loader (no import assertions, no createRequire)
// ───────────────────────────────────────────────────────────────────────────────
let _ILPPPoolABI: any | null = null
async function ILPPPoolABI(): Promise<any> {
  if (_ILPPPoolABI) return _ILPPPoolABI
  try {
    // If your artifact is named plainly:
    _ILPPPoolABI = (await artifacts.readArtifact('ILPPPool')).abi
  } catch {
    // FQN fallback if Hardhat needs the fully-qualified name:
    _ILPPPoolABI = (await artifacts.readArtifact('contracts/interfaces/ILPPPool.sol:ILPPPool')).abi
  }
  return _ILPPPoolABI
}

// ───────────────────────────────────────────────────────────────────────────────
// Small helpers
// ───────────────────────────────────────────────────────────────────────────────
async function addr(x: any): Promise<string> {
  if (typeof x === 'string') return x
  if (x?.getAddress) return x.getAddress()
  if (x?.target) return x.target as string
  if (x?.address) return x.address as string
  throw new Error('Cannot resolve address from value')
}

function hasFn(c: { interface: any }, name: string): boolean {
  try {
    c.interface.getFunction(name)
    return true
  } catch {
    return false
  }
}

async function callIfExists(c: any, name: string, args: any[] = []) {
  if (!hasFn(c, name)) return false
  const tx = await c[name](...args)
  await tx.wait()
  return true
}

async function isHooked(poolAddr: string, factory: any): Promise<boolean> {
  try {
    const pool = new Contract(poolAddr, await ILPPPoolABI(), factory.runner ?? factory.signer)
    if (hasFn(pool as any, 'hook')) {
      const h: string = await (pool as any).hook()
      if (h && h !== '0x0000000000000000000000000000000000000000') return true
    }
  } catch {}

  try {
    const fac = new Contract(await factory.getAddress(), (factory as any).interface.fragments, factory.runner ?? factory.signer)
    if (hasFn(fac as any, 'isHookedPool')) return await (fac as any).isHookedPool(poolAddr)
    if (hasFn(fac as any, 'hookedPools')) return await (fac as any).hookedPools(poolAddr)
  } catch {}
  return false
}

async function ensureHookedPool(factory: ILPPFactory, hook: LPPMintHook, token0: string, token1: string) {
  const [signer] = await ethers.getSigners()
  const factoryAddr = await factory.getAddress()
  const fac = new Contract(factoryAddr, (factory as any).interface.fragments, signer)

  const poolAddr: string = await (factory as any).getPool(token0, token1, FEE)
  if ((await ethers.provider.getCode(poolAddr)) === '0x') {
    if (hasFn(fac as any, 'createPool')) {
      const frag = (fac as any).interface.getFunction('createPool')
      if (frag.inputs.length === 3) {
        await (fac as any).createPool(token0, token1, FEE).then((tx: any) => tx.wait())
      } else if (frag.inputs.length === 4) {
        await (fac as any).createPool(token0, token1, FEE, await hook.getAddress()).then((tx: any) => tx.wait())
      }
    }
  }

  try {
    const pool = new Contract(poolAddr, await ILPPPoolABI(), signer)
    if (hasFn(pool as any, 'initialize')) {
      await (pool as any).initialize(encodePriceSqrt(1, 1)).then((tx: any) => tx.wait()).catch(() => {})
    }
  } catch {}

  if (await isHooked(poolAddr, factory)) return

  try {
    await callIfExists(fac as any, 'setPoolHook', [poolAddr, await hook.getAddress()]) ||
      await callIfExists(fac as any, 'setHookForPool', [poolAddr, await hook.getAddress()]) ||
      await callIfExists(fac as any, 'attachHook', [poolAddr, await hook.getAddress()]) ||
      await callIfExists(fac as any, 'enableHook', [poolAddr, await hook.getAddress()]) ||
      await callIfExists(fac as any, 'whitelistPool', [poolAddr, true])
  } catch {}

  try {
    const hookCtr = new Contract(await hook.getAddress(), (hook as any).interface.fragments, signer)
    await callIfExists(hookCtr as any, 'registerPool', [poolAddr]) ||
      await callIfExists(hookCtr as any, 'attachPool', [poolAddr]) ||
      await callIfExists(hookCtr as any, 'setPoolHook', [poolAddr, await hook.getAddress()])
  } catch {}

  if (!(await isHooked(poolAddr, factory))) {
    // eslint-disable-next-line no-console
    console.warn('Pool exists but still appears unhooked (continuing best-effort):', poolAddr)
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────────
describe('NonfungiblePositionManager', () => {
  let wallets: Signer[]
  let wallet: Signer
  let other: Signer
  let hook: LPPMintHook

  let factory: ILPPFactory
  let nft: MockTimeNonfungiblePositionManager
  let tokens: [TestERC20, TestERC20, TestERC20]
  let weth9: IWETH9
  let router: SupplicateRouter

  before(async () => {
    wallets = await ethers.getSigners()
    ;[wallet, other] = wallets
  })

  async function nftFixture() {
    const signers = await ethers.getSigners()
    const { weth9: w, factory: f, tokens: t, nft: n, router: r, hook: hf } = await completeFixture(signers as any, ethers.provider)

    hook = hf as unknown as LPPMintHook

    const caller = await signers[0].getAddress()
    try {
      if ((n as any).setMintHook) await (n as any).setMintHook(caller)
      else if ((n as any).setHook) await (n as any).setHook(caller)
      else if ((hook as any).setMintHook) await (hook as any).setMintHook(caller)
      else if ((hook as any).authorize) await (hook as any).authorize(caller, true)
    } catch {}

    try {
      if ((hook as any).setManager) await (hook as any).setManager(await (n as any).getAddress())
    } catch {}

    const nftAddr = await (n as any).getAddress()
    const otherAddr = await signers[1].getAddress()
    for (const tk of t) {
      await tk.approve(nftAddr, MaxUint256)
      await tk.connect(signers[1]).approve(nftAddr, MaxUint256)
      await tk.transfer(otherAddr, expandTo18Decimals(1_000_000))
    }

    return { nft: n as typeof nft, factory: f as typeof factory, tokens: t as typeof tokens, weth9: w as typeof weth9, router: r as typeof router, hook }
  }

  async function getPoolAddr(token0: string, token1: string) {
    return await (factory as any).getPool(token0, token1, FEE)
  }

  async function quoteMintRebate(h: any, pool: string, params: MintParams): Promise<bigint> {
    try {
      if (hasFn(h as any, 'quoteMintRebate')) {
        const v = await (h as any).quoteMintRebate(
          pool, params.tickLower, params.tickUpper, params.amount0Desired, params.amount1Desired
        )
        return BigInt(v)
      }
      if (hasFn(h as any, 'quoteAddLiquidityRebate')) {
        const v = await (h as any).quoteAddLiquidityRebate(
          pool, params.tickLower, params.tickUpper, params.amount0Desired, params.amount1Desired
        )
        return BigInt(v)
      }
    } catch {}
    return 0n
  }

  async function quoteIncreaseRebate(h: any, pool: string, inc: IncParams): Promise<bigint> {
    try {
      if (hasFn(h as any, 'quoteIncreaseLiquidityRebate')) {
        const v = await (h as any).quoteIncreaseLiquidityRebate(pool, inc.tokenId, inc.amount0Desired, inc.amount1Desired)
        return BigInt(v)
      }
      if (hasFn(h as any, 'quoteAddLiquidityRebate')) {
        const v = await (h as any).quoteAddLiquidityRebate(pool, 0, 0, inc.amount0Desired, inc.amount1Desired)
        return BigInt(v)
      }
    } catch {}
    return 0n
  }

  async function mintWithRebate(params: MintParams) {
    const pool = await getPoolAddr(params.token0, params.token1)
    const value = await quoteMintRebate(hook, pool, params)
    return (nft as any).mint(params, { value })
  }

  async function increaseWithRebate(inc: IncParams) {
    const pos: any = await (nft as any).positions(inc.tokenId)
    const pool = await getPoolAddr(pos.token0, pos.token1)
    const value = await quoteIncreaseRebate(hook, pool, inc)
    return (nft as any).increaseLiquidity(inc, { value })
  }

  beforeEach(async () => {
    ;({ nft, factory, tokens, weth9, router, hook } = await loadFixture(nftFixture))
  })

  it('bytecode size', async () => {
    const code = await ethers.provider.getCode(await (nft as any).getAddress())
    expect((code.length - 2) / 2).to.matchSnapshot()
  })

  describe('#createAndInitializePoolIfNecessary', () => {
    it('creates the pool at the expected address', async () => {
      const factoryAddr = await (factory as any).getAddress()
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      const expectedAddress = await computeExpectedPool(factoryAddr, token0Addr, token1Addr, FEE)

      const code = await ethers.provider.getCode(expectedAddress)
      expect(code).to.eq('0x')

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)

      const codeAfter = await ethers.provider.getCode(expectedAddress)
      expect(codeAfter).to.not.eq('0x')
    })

    it('is payable', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1), { value: 1 })
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)
    })

    it('works if pool is created but not initialized', async () => {
      const factoryAddr = await (factory as any).getAddress()
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      const expectedAddress = await computeExpectedPool(factoryAddr, token0Addr, token1Addr, FEE)

      if (hasFn(factory as any, 'createPool')) {
        await (factory as any).createPool(token0Addr, token1Addr, FEE)
      }
      const code = await ethers.provider.getCode(expectedAddress)
      expect(code).to.not.eq('0x')

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(2, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)
    })

    it('works if pool is created and initialized', async () => {
      const factoryAddr = await (factory as any).getAddress()
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      const expectedAddress = await computeExpectedPool(factoryAddr, token0Addr, token1Addr, FEE)

      if (hasFn(factory as any, 'createPool')) {
        await (factory as any).createPool(token0Addr, token1Addr, FEE)
      }
      const pool = new Contract(expectedAddress, await ILPPPoolABI(), wallet as any)
      if (hasFn(pool as any, 'initialize')) {
        await (pool as any).initialize(encodePriceSqrt(3, 1))
      }

      const code = await ethers.provider.getCode(expectedAddress)
      expect(code).to.not.eq('0x')

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(4, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)
    })

    it('could theoretically use eth via multicall', async () => {
      const [t0, t1] = sortedTokens(weth9, tokens[0])
      const token0Addr = await addr(t0)
      const token1Addr = await addr(t1)

      const createAndInitializePoolIfNecessaryData = (nft.interface as any).encodeFunctionData(
        'createAndInitializePoolIfNecessary',
        [token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1)]
      )
      await (nft as any).multicall([createAndInitializePoolIfNecessaryData], { value: expandTo18Decimals(1) })
    })

    it('gas', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      await snapshotGasCost((nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1)))
    })
  })

  describe('#mint', () => {
    it('fails if pool does not exist', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await expect(
        (nft as any).mint({
          token0: token0Addr,
          token1: token1Addr,
          tickLower: getMinTick(TICK_SPACING),
          tickUpper: getMaxTick(TICK_SPACING),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          recipient: await (wallet as any).getAddress(),
          deadline: 1,
          fee: FEE,
        } as MintParams)
      ).to.be.reverted
    })

    it('fails if cannot transfer', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)

      const nftAddr = await (nft as any).getAddress()
      await tokens[0].approve(nftAddr, 0)

      await expect(
        mintWithRebate({
          token0: token0Addr,
          token1: token1Addr,
          fee: FEE,
          tickLower: getMinTick(TICK_SPACING),
          tickUpper: getMaxTick(TICK_SPACING),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          recipient: await (wallet as any).getAddress(),
          deadline: 1,
        } as MintParams)
      ).to.be.revertedWith('STF')
    })

    it('creates a token', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      const otherAddr = await (other as any).getAddress()

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)

      await mintWithRebate({
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
      } as MintParams)

      expect(await (nft as any).balanceOf(otherAddr)).to.eq(1)
      expect(await (nft as any).tokenOfOwnerByIndex(otherAddr, 0)).to.eq(1)

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
      } = await (nft as any).positions(1)

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
      const otherAddr = await (other as any).getAddress()

      const nftAddr = await (nft as any).getAddress()
      await weth9.approve(nftAddr, 0)

      const createAndInitializeData = (nft.interface as any).encodeFunctionData('createAndInitializePoolIfNecessary', [
        token0Addr,
        token1Addr,
        FEE,
        encodePriceSqrt(1, 1),
      ])

      const mintParams: MintParams = {
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
      }
      const pool = await getPoolAddr(token0Addr, token1Addr)
      const rebate = await quoteMintRebate(hook, pool, mintParams)

      const mintData = (nft.interface as any).encodeFunctionData('mint', [mintParams])
      const refundETHData = (nft.interface as any).encodeFunctionData('refundETH')

      const balanceBefore = await ethers.provider.getBalance(await (wallet as any).getAddress())
      const tx = await (nft as any).multicall([createAndInitializeData, mintData, refundETHData], { value: rebate })
      const receipt = await tx.wait()
      const gasPrice = (receipt as any).effectiveGasPrice ?? tx.gasPrice ?? 0n
      const balanceAfter = await ethers.provider.getBalance(await (wallet as any).getAddress())

      expect(balanceBefore).to.eq(balanceAfter + (receipt!.gasUsed as bigint) * (gasPrice as bigint))
    })

    it('emits an event')

    it('gas first mint for pool', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)

      await snapshotGasCost(
        mintWithRebate({
          token0: token0Addr,
          token1: token1Addr,
          tickLower: getMinTick(TICK_SPACING),
          tickUpper: getMaxTick(TICK_SPACING),
          fee: FEE,
          recipient: await (wallet as any).getAddress(),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        } as MintParams)
      )
    })

    it('gas first mint for pool using eth with zero refund', async () => {
      const [t0, t1] = sortedTokens(weth9, tokens[0])
      const token0Addr = await addr(t0)
      const token1Addr = await addr(t1)

      const mintParams: MintParams = {
        token0: token0Addr,
        token1: token1Addr,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        fee: FEE,
        recipient: await (wallet as any).getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 10,
      }

      const pool = await getPoolAddr(token0Addr, token1Addr)
      const rebate = await quoteMintRebate(hook, pool, mintParams)

      await snapshotGasCost(
        (nft as any).multicall(
          [
            (nft.interface as any).encodeFunctionData('mint', [mintParams]),
            (nft.interface as any).encodeFunctionData('refundETH'),
          ],
          { value: rebate }
        )
      )
    })

    it('gas first mint for pool using eth with non-zero refund', async () => {
      const [t0, t1] = sortedTokens(weth9, tokens[0])
      const token0Addr = await addr(t0)
      const token1Addr = await addr(t1)

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)

      const mintParams: MintParams = {
        token0: token0Addr,
        token1: token1Addr,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        fee: FEE,
        recipient: await (wallet as any).getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 10,
      }

      const pool   = await getPoolAddr(token0Addr, token1Addr)
      const rebate = await quoteMintRebate(hook, pool, mintParams)

      await snapshotGasCost(
        (nft as any).multicall(
          [
            (nft.interface as any).encodeFunctionData('mint', [mintParams]),
            (nft.interface as any).encodeFunctionData('refundETH'),
          ],
          { value: rebate + 1n }
        )
      )
    })

    it('gas mint on same ticks', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)

      await mintWithRebate({
        token0: token0Addr,
        token1: token1Addr,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        fee: FEE,
        recipient: await (other as any).getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 10,
      } as MintParams)

      await snapshotGasCost(
        mintWithRebate({
          token0: token0Addr,
          token1: token1Addr,
          tickLower: getMinTick(TICK_SPACING),
          tickUpper: getMaxTick(TICK_SPACING),
          fee: FEE,
          recipient: await (wallet as any).getAddress(),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        } as MintParams)
      )
    })

    it('gas mint for same pool, different ticks', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)

      await mintWithRebate({
        token0: token0Addr,
        token1: token1Addr,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        fee: FEE,
        recipient: await (other as any).getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 10,
      } as MintParams)

      await snapshotGasCost(
        mintWithRebate({
          token0: token0Addr,
          token1: token1Addr,
          tickLower: getMinTick(TICK_SPACING) + TICK_SPACING,
          tickUpper: getMaxTick(TICK_SPACING) - TICK_SPACING,
          fee: FEE,
          recipient: await (wallet as any).getAddress(),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        } as MintParams)
      )
    })
  })

  describe('#increaseLiquidity', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)
      await mintWithRebate({
        token0: token0Addr,
        token1: token1Addr,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        fee: FEE,
        recipient: await (other as any).getAddress(),
        amount0Desired: 1000,
        amount1Desired: 1000,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      } as MintParams)
    })

    it('increases position liquidity', async () => {
      await increaseWithRebate({
        tokenId,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      } as IncParams)
      const { liquidity } = await (nft as any).positions(tokenId)
      expect(liquidity).to.eq(1100)
    })

    it('emits an event')

    it('can be paid with ETH', async () => {
      const [a, b] = sortedTokens(tokens[0], weth9)
      const token0Addr = await addr(a)
      const token1Addr = await addr(b)
      const otherAddr = await (other as any).getAddress()

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)

      const mintData = (nft.interface as any).encodeFunctionData('mint', [
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
        } as MintParams,
      ])
      const refundETHData = (nft.interface as any).encodeFunctionData('unwrapWETH9', [0, otherAddr])
      await (nft as any).multicall([mintData, refundETHData], { value: expandTo18Decimals(1) })

      const increaseLiquidityData = (nft.interface as any).encodeFunctionData('increaseLiquidity', [
        {
          tokenId: 1,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        } as IncParams,
      ])
      await (nft as any).multicall([increaseLiquidityData, refundETHData], { value: expandTo18Decimals(1) })
    })

    it('gas', async () => {
      await snapshotGasCost(
        (nft as any).increaseLiquidity({
          tokenId: tokenId,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        } as IncParams)
      )
    })
  })

  describe('#decreaseLiquidity', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)
      await mintWithRebate({
        token0: token0Addr,
        token1: token1Addr,
        fee: FEE,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        recipient: await (other as any).getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      } as MintParams)
    })

    it('emits an event')

    it('fails if past deadline', async () => {
      await (nft as any).setTime(2)
      await expect(
        (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.revertedWith('Transaction too old')
    })

    it('cannot be called by other addresses', async () => {
      await expect(
        (nft as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.revertedWith('Not approved')
    })

    it('decreases position liquidity', async () => {
      await (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 25, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const { liquidity } = await (nft as any).positions(tokenId)
      expect(liquidity).to.eq(75)
    })

    it('is payable', async () => {
      await (nft.connect(other) as any)
        .decreaseLiquidity({ tokenId: tokenId, liquidity: 25, amount0Min: 0, amount1Min: 0, deadline: 1 }, { value: 1 })
    })

    it('accounts for tokens owed', async () => {
      await (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 25, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const { tokensOwed0, tokensOwed1 } = await (nft as any).positions(tokenId)
      expect(tokensOwed0).to.eq(24)
      expect(tokensOwed1).to.eq(24)
    })

    it('can decrease for all the liquidity', async () => {
      await (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const { liquidity } = await (nft as any).positions(tokenId)
      expect(liquidity).to.eq(0)
    })

    it('cannot decrease for more than all the liquidity', async () => {
      await expect(
        (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 101, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.reverted
    })

    it('cannot decrease for more than the liquidity of the nft position', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      await mintWithRebate({
        token0: token0Addr,
        token1: token1Addr,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        fee: FEE,
        recipient: await (other as any).getAddress(),
        amount0Desired: 200,
        amount1Desired: 200,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      } as MintParams)
      await expect(
        (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 101, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.reverted
    })

    it('gas partial decrease', async () => {
      await snapshotGasCost(
        (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      )
    })

    it('gas complete decrease', async () => {
      await snapshotGasCost(
        (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      )
    })
  })

  describe('#collect', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)
      await mintWithRebate({
        token0: token0Addr,
        token1: token1Addr,
        fee: FEE,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        recipient: await (other as any).getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      } as MintParams)
    })

    it('emits an event')

    it('cannot be called by other addresses', async () => {
      await expect(
        (nft as any).collect({
          tokenId: tokenId,
          recipient: await (wallet as any).getAddress(),
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
      ).to.be.revertedWith('Not approved')
    })

    it('cannot be called with 0 for both amounts', async () => {
      await expect(
        (nft.connect(other) as any).collect({
          tokenId: tokenId,
          recipient: await (wallet as any).getAddress(),
          amount0Max: 0,
          amount1Max: 0,
        })
      ).to.be.reverted
    })

    it('no op if no tokens are owed', async () => {
      const txNoOp = (nft.connect(other) as any).collect({
        tokenId: tokenId,
        recipient: await (wallet as any).getAddress(),
        amount0Max: MaxUint128,
        amount1Max: MaxUint128,
      })
      await expect(txNoOp).to.not.emit(tokens[0], 'Transfer')
      await expect(txNoOp).to.not.emit(tokens[1], 'Transfer')
    })

    it('transfers tokens owed from burn', async () => {
      await (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const factoryAddr = await (factory as any).getAddress()
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      const poolAddress = await computeExpectedPool(factoryAddr, token0Addr, token1Addr, FEE)

      const recipient = await (wallet as any).getAddress()
      await expect(
        (nft.connect(other) as any).collect({
          tokenId: tokenId,
          recipient,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
      )
        .to.emit(tokens[0], 'Transfer')
        .withArgs(poolAddress, recipient, 49)
        .and.to.emit(tokens[1], 'Transfer')
        .withArgs(poolAddress, recipient, 49)
    })

    it('gas transfers both', async () => {
      await (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await snapshotGasCost(
        (nft.connect(other) as any).collect({
          tokenId: tokenId,
          recipient: await (wallet as any).getAddress(),
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
      )
    })

    it('gas transfers token0 only', async () => {
      await (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await snapshotGasCost(
        (nft.connect(other) as any).collect({
          tokenId: tokenId,
          recipient: await (wallet as any).getAddress(),
          amount0Max: MaxUint128,
          amount1Max: 0,
        })
      )
    })

    it('gas transfers token1 only', async () => {
      await (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await snapshotGasCost(
        (nft.connect(other) as any).collect({
          tokenId: tokenId,
          recipient: await (wallet as any).getAddress(),
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

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)
      await mintWithRebate({
        token0: token0Addr,
        token1: token1Addr,
        fee: FEE,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        recipient: await (other as any).getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      } as MintParams)
    })

    it('emits an event')

    it('cannot be called by other addresses', async () => {
      await expect((nft as any).burn(tokenId)).to.be.revertedWith('Not approved')
    })

    it('cannot be called while there is still liquidity', async () => {
      await expect((nft.connect(other) as any).burn(tokenId)).to.be.revertedWith('Not cleared')
    })

    it('cannot be called while there is still partial liquidity', async () => {
      await (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await expect((nft.connect(other) as any).burn(tokenId)).to.be.revertedWith('Not cleared')
    })

    it('cannot be called while there is still tokens owed', async () => {
      await (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await expect((nft.connect(other) as any).burn(tokenId)).to.be.revertedWith('Not cleared')
    })

    it('deletes the token', async () => {
      await (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await (nft.connect(other) as any).collect({
        tokenId: tokenId,
        recipient: await (wallet as any).getAddress(),
        amount0Max: MaxUint128,
        amount1Max: MaxUint128,
      })
      await (nft.connect(other) as any).burn(tokenId)
      await expect((nft as any).positions(tokenId)).to.be.revertedWith('Invalid token ID')
    })

    it('gas', async () => {
      await (nft.connect(other) as any).decreaseLiquidity({ tokenId: tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await (nft.connect(other) as any).collect({
        tokenId: tokenId,
        recipient: await (wallet as any).getAddress(),
        amount0Max: MaxUint128,
        amount1Max: MaxUint128,
      })
      await snapshotGasCost((nft.connect(other) as any).burn(tokenId))
    })
  })

  describe('#transferFrom', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)
      await mintWithRebate({
        token0: token0Addr,
        token1: token1Addr,
        fee: FEE,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        recipient: await (other as any).getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      } as MintParams)
    })

    it('can only be called by authorized or owner', async () => {
      await expect((nft as any).transferFrom(await (other as any).getAddress(), await (wallet as any).getAddress(), tokenId)).to.be.revertedWith(
        'ERC721: transfer caller is not owner nor approved'
      )
    })

    it('changes the owner', async () => {
      await (nft.connect(other) as any).transferFrom(await (other as any).getAddress(), await (wallet as any).getAddress(), tokenId)
      expect(await (nft as any).ownerOf(tokenId)).to.eq(await (wallet as any).getAddress())
    })

    it('removes existing approval', async () => {
      await (nft.connect(other) as any).approve(await (wallet as any).getAddress(), tokenId)
      expect(await (nft as any).getApproved(tokenId)).to.eq(await (wallet as any).getAddress())
      await (nft as any).transferFrom(await (other as any).getAddress(), await (wallet as any).getAddress(), tokenId)
      expect(await (nft as any).getApproved(tokenId)).to.eq('0x0000000000000000000000000000000000000000')
    })

    it('gas', async () => {
      await snapshotGasCost((nft.connect(other) as any).transferFrom(await (other as any).getAddress(), await (wallet as any).getAddress(), tokenId))
    })

    it('gas comes from approved', async () => {
      await (nft.connect(other) as any).approve(await (wallet as any).getAddress(), tokenId)
      await snapshotGasCost((nft as any).transferFrom(await (other as any).getAddress(), await (wallet as any).getAddress(), tokenId))
    })
  })

  describe('#permit', () => {
    it('emits an event')

    describe('owned by eoa', () => {
      const tokenId = 1
      beforeEach('create a position', async () => {
        const token0Addr = await tokens[0].getAddress()
        const token1Addr = await tokens[1].getAddress()

        await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
        await ensureHookedPool(factory, hook, token0Addr, token1Addr)
        await mintWithRebate({
          token0: token0Addr,
          token1: token1Addr,
          fee: FEE,
          tickLower: getMinTick(TICK_SPACING),
          tickUpper: getMaxTick(TICK_SPACING),
          recipient: await (other as any).getAddress(),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        } as MintParams)
      })

      it('changes the operator of the position and increments the nonce', async () => {
        const sig = await getPermitNFTSignature(other as any, nft, await (wallet as any).getAddress(), tokenId, 1)
        await (nft as any).permit(await (wallet as any).getAddress(), tokenId, 1, sig.v, sig.r, sig.s)
        expect((await (nft as any).positions(tokenId)).nonce).to.eq(1)
        expect((await (nft as any).positions(tokenId)).operator).to.eq(await (wallet as any).getAddress())
      })

      it('cannot be called twice with the same signature', async () => {
        const sig = await getPermitNFTSignature(other as any, nft, await (wallet as any).getAddress(), tokenId, 1)
        await (nft as any).permit(await (wallet as any).getAddress(), tokenId, 1, sig.v, sig.r, sig.s)
        await expect((nft as any).permit(await (wallet as any).getAddress(), tokenId, 1, sig.v, sig.r, sig.s)).to.be.reverted
      })

      it('fails with invalid signature', async () => {
        const sig = await getPermitNFTSignature(wallet as any, nft, await (wallet as any).getAddress(), tokenId, 1)
        await expect((nft as any).permit(await (wallet as any).getAddress(), tokenId, 1, (sig.v as number) + 3, sig.r, sig.s)).to.be
          .revertedWith('Invalid signature')
      })

      it('fails with signature not from owner', async () => {
        const sig = await getPermitNFTSignature(wallet as any, nft, await (wallet as any).getAddress(), tokenId, 1)
        await expect((nft as any).permit(await (wallet as any).getAddress(), tokenId, 1, sig.v, sig.r, sig.s)).to.be.revertedWith(
          'Unauthorized'
        )
      })

      it('fails with expired signature', async () => {
        await (nft as any).setTime(2)
        const sig = await getPermitNFTSignature(other as any, nft, await (wallet as any).getAddress(), tokenId, 1)
        await expect((nft as any).permit(await (wallet as any).getAddress(), tokenId, 1, sig.v, sig.r, sig.s)).to.be.revertedWith(
          'Permit expired'
        )
      })

      it('gas', async () => {
        const sig = await getPermitNFTSignature(other as any, nft, await (wallet as any).getAddress(), tokenId, 1)
        await snapshotGasCost((nft as any).permit(await (wallet as any).getAddress(), tokenId, 1, sig.v, sig.r, sig.s))
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

        await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
        await ensureHookedPool(factory, hook, token0Addr, token1Addr)
        await mintWithRebate({
          token0: token0Addr,
          token1: token1Addr,
          fee: FEE,
          tickLower: getMinTick(TICK_SPACING),
          tickUpper: getMaxTick(TICK_SPACING),
          recipient: await (testPositionNFTOwner as any).getAddress(),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        } as MintParams)
      })

      it('changes the operator of the position and increments the nonce', async () => {
        const sig = await getPermitNFTSignature(other as any, nft, await (wallet as any).getAddress(), tokenId, 1)
        await (testPositionNFTOwner as any).setOwner(await (other as any).getAddress())
        await (nft as any).permit(await (wallet as any).getAddress(), tokenId, 1, sig.v, sig.r, sig.s)
        expect((await (nft as any).positions(tokenId)).nonce).to.eq(1)
        expect((await (nft as any).positions(tokenId)).operator).to.eq(await (wallet as any).getAddress())
      })

      it('fails if owner contract is owned by different address', async () => {
        const sig = await getPermitNFTSignature(other as any, nft, await (wallet as any).getAddress(), tokenId, 1)
        await (testPositionNFTOwner as any).setOwner(await (wallet as any).getAddress())
        await expect((nft as any).permit(await (wallet as any).getAddress(), tokenId, 1, sig.v, sig.r, sig.s)).to.be.revertedWith(
          'Unauthorized'
        )
      })

      it('fails with signature not from owner', async () => {
        const sig = await getPermitNFTSignature(wallet as any, nft, await (wallet as any).getAddress(), tokenId, 1)
        await (testPositionNFTOwner as any).setOwner(await (other as any).getAddress())
        await expect((nft as any).permit(await (wallet as any).getAddress(), tokenId, 1, sig.v, sig.r, sig.s)).to.be.revertedWith(
          'Unauthorized'
        )
      })

      it('fails with expired signature', async () => {
        await (nft as any).setTime(2)
        const sig = await getPermitNFTSignature(other as any, nft, await (wallet as any).getAddress(), tokenId, 1)
        await (testPositionNFTOwner as any).setOwner(await (other as any).getAddress())
        await expect((nft as any).permit(await (wallet as any).getAddress(), tokenId, 1, sig.v, sig.r, sig.s)).to.be.revertedWith(
          'Permit expired'
        )
      })

      it('gas', async () => {
        const sig = await getPermitNFTSignature(other as any, nft, await (wallet as any).getAddress(), tokenId, 1)
        await (testPositionNFTOwner as any).setOwner(await (other as any).getAddress())
        await snapshotGasCost((nft as any).permit(await (wallet as any).getAddress(), tokenId, 1, sig.v, sig.r, sig.s))
      })
    })
  })

  describe('multicall exit', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)
      await mintWithRebate({
        token0: token0Addr,
        token1: token1Addr,
        fee: FEE,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        recipient: await (other as any).getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      } as MintParams)
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
      const decreaseLiquidityData = (nft.interface as any).encodeFunctionData('decreaseLiquidity', [
        { tokenId, liquidity, amount0Min, amount1Min, deadline: 1 },
      ])
      const collectData = (nft.interface as any).encodeFunctionData('collect', [
        { tokenId, recipient, amount0Max: MaxUint128, amount1Max: MaxUint128 },
      ])
      const burnData = (nft.interface as any).encodeFunctionData('burn', [tokenId])
      return (nft as any).multicall([decreaseLiquidityData, collectData, burnData])
    }

    it('executes all the actions', async () => {
      const factoryAddr = await (factory as any).getAddress()
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()
      const expected = await computeExpectedPool(factoryAddr, token0Addr, token1Addr, FEE)
      const pool = poolAtAddress(expected, wallet as any)

      await expect(
        exit({
          nft: nft.connect(other) as any,
          tokenId: tokenId,
          liquidity: 100,
          amount0Min: 0,
          amount1Min: 0,
          recipient: await (wallet as any).getAddress(),
        })
      )
        .to.emit(pool, 'Burn')
        .and.to.emit(pool, 'Collect')
    })

    it('gas', async () => {
      await snapshotGasCost(
        exit({
          nft: nft.connect(other) as any,
          tokenId: tokenId,
          liquidity: 100,
          amount0Min: 0,
          amount1Min: 0,
          recipient: await (wallet as any).getAddress(),
        })
      )
    })
  })

  describe('#tokenURI', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)
      await mintWithRebate({
        token0: token0Addr,
        token1: token1Addr,
        fee: FEE,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        recipient: await (other as any).getAddress(),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      } as MintParams)
    })

    it('reverts for invalid token id', async () => {
      await expect((nft as any).tokenURI(tokenId + 1)).to.be.reverted
    })

    it('returns a data URI with correct mime type', async () => {
      expect(await (nft as any).tokenURI(tokenId)).to.match(/data:application\/json;base64,.+/)
    })

    it('content is valid JSON and structure', async () => {
      const content = extractJSONFromURI(await (nft as any).tokenURI(tokenId))
      expect(content).to.haveOwnProperty('name').is.a('string')
      expect(content).to.haveOwnProperty('description').is.a('string')
      expect(content).to.haveOwnProperty('image').is.a('string')
    })
  })

  describe('#positions', () => {
    it('gas', async () => {
      const positionsGasTestFactory = await ethers.getContractFactory('NonfungiblePositionManagerPositionsGasTest')
      const positionsGasTest = (await positionsGasTestFactory.deploy(
        await (nft as any).getAddress()
      )) as unknown as NonfungiblePositionManagerPositionsGasTest

      const token0Addr = await tokens[0].getAddress()
      const token1Addr = await tokens[1].getAddress()

      await (nft as any).createAndInitializePoolIfNecessary(token0Addr, token1Addr, FEE, encodePriceSqrt(1, 1))
      await ensureHookedPool(factory, hook, token0Addr, token1Addr)
      await mintWithRebate({
        token0: token0Addr,
        token1: token1Addr,
        tickLower: getMinTick(TICK_SPACING),
        tickUpper: getMaxTick(TICK_SPACING),
        fee: FEE,
        recipient: await (other as any).getAddress(),
        amount0Desired: 15,
        amount1Desired: 15,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 10,
      } as MintParams)

      await snapshotGasCost((positionsGasTest as any).getGasCostOfPositions(1))
    })
  })
})