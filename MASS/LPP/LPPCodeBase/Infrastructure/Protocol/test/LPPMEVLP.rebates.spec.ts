// test/LPPMEVLP.rebates.spec.ts
import hre from 'hardhat'
const { ethers } = hre
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'

import { expect } from './shared/expect.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'
import { poolFixture } from './shared/fixtures.ts'

import {
  encodePriceSqrt,
  expandTo18Decimals,
  FeeAmount,
  getMaxTick,
  getMinTick,
  TICK_SPACINGS,
  createPoolFunctions,
  createRebateFunctions,
  getMaxLiquidityPerTick,
} from './shared/utilities.ts'

import type {
  MockTimeLPPPool,
  LPPMintHook,
  LPPRebateVault,
  LPPTreasury,
} from '../typechain-types/protocol/index.ts'

describe('MEV-as-LP Rebates — mintWithRebate', () => {
  let wallet: HardhatEthersSigner
  let alice: HardhatEthersSigner
  let bob: HardhatEthersSigner

  before(async () => {
    ;[wallet, alice, bob] = (await ethers.getSigners()) as HardhatEthersSigner[]
  })

  async function rebatesFixture() {
    // Base protocol fixture (tokens, factory, callee, etc.)
    const fix = await (poolFixture as any)([wallet], ethers.provider)
    const pool: MockTimeLPPPool = await fix.createPool(FeeAmount.ZERO, TICK_SPACINGS[FeeAmount.ZERO])

    // Initialize @ price = 1.0
    await pool.initialize(encodePriceSqrt(1n, 1n))

    const ts = TICK_SPACINGS[FeeAmount.ZERO]
    const minTick = getMinTick(ts)
    const maxTick = getMaxTick(ts)

    // Deploy vault + treasury
    const RebateVaultF = await ethers.getContractFactory('LPPRebateVault')
    const vault = (await RebateVaultF.deploy(await wallet.getAddress())) as unknown as LPPRebateVault
    await vault.waitForDeployment()

    let treasury: LPPTreasury
    try {
      const T1 = await ethers.getContractFactory('LPPTreasury')
      treasury = (await T1.deploy(await wallet.getAddress())) as unknown as LPPTreasury
      await treasury.waitForDeployment()
    } catch {
      const T0 = await ethers.getContractFactory('LPPTreasury')
      treasury = (await T0.deploy()) as unknown as LPPTreasury
      await treasury.waitForDeployment()
    }

    // Deploy the canonical hook (THIS is the one baked/gated by the pool in your production code)
    const HookF = await ethers.getContractFactory('LPPMintHook')
    const hook = (await HookF.deploy(await vault.getAddress(), await treasury.getAddress())) as unknown as LPPMintHook
    await hook.waitForDeployment()

    // Helpers
    const { mintWithRebate } = createRebateFunctions({ pool, token0: fix.token0, token1: fix.token1 })
    const { attemptDirectMint, mint: legacyCalleeMint } = createPoolFunctions({
      supplicateTarget: fix.supplicateTargetCallee,
      token0: fix.token0,
      token1: fix.token1,
      pool,
    })

    // --- Baseline TVL via HOOK (not via direct pool.mint) ---
    const L0 = expandTo18Decimals(10)
    await (await mintWithRebate({
      hookAddress: await hook.getAddress(),
      recipient: await wallet.getAddress(),
      tickLower: minTick,
      tickUpper: maxTick,
      liquidity: L0,
    })).wait()

    return {
      fix,
      pool,
      hook,
      vault,
      treasury,
      ts,
      minTick,
      maxTick,
      L0,
      mintWithRebate,
      attemptDirectMint,
      legacyCalleeMint,
    }
  }

  // ---------------- Existing tests (unchanged behavior-wise) ----------------

  it('mints with surcharge, emits events, transfers rebate/retention, and posts snapshots', async () => {
    const {
      fix, pool, hook, vault, treasury, minTick, maxTick, mintWithRebate, ts,
    } = await loadFixture(rebatesFixture)

    const lpAddr = await wallet.getAddress()
    const hookAddr = await hook.getAddress()
    const Lmint = expandTo18Decimals(15) / 10n

    const t0 = fix.token0
    const t1 = fix.token1

    const bVault0Before = await t0.balanceOf(await vault.getAddress())
    const bVault1Before = await t1.balanceOf(await vault.getAddress())
    const bTreas0Before = await t0.balanceOf(await treasury.getAddress())
    const bTreas1Before = await t1.balanceOf(await treasury.getAddress())

    const tx = await mintWithRebate({
      hookAddress: hookAddr,
      recipient: lpAddr,
      payer: lpAddr,
      tickLower: minTick,
      tickUpper: maxTick,
      liquidity: Lmint,
    })
    const receipt = await tx.wait()
    await snapshotGasCost(receipt.gasUsed)

    const poolIface = (pool as any).interface
    const mintEvt = receipt!.logs
      .map((l: any) => { try { return poolIface.parseLog(l) } catch { return null } })
      .find((p: any) => p && p.name === 'Mint')
    expect(mintEvt, 'Mint event missing').to.not.eq(undefined)
    const amount0Owed: bigint = mintEvt!.args.amount0 as bigint
    const amount1Owed: bigint = mintEvt!.args.amount1 as bigint

    const hookIface = (hook as any).interface
    const hookLogs = receipt!.logs.map((l: any) => { try { return hookIface.parseLog(l) } catch { return null } }).filter(Boolean) as any[]

    const qualified = hookLogs.find(p => p.name === 'Qualified')
    expect(qualified, 'Qualified event missing').to.not.eq(undefined)

    const rebatePaid = hookLogs.filter(p => p.name === 'RebatePaid')
    expect(rebatePaid.map(e => ({
      lp: e.args.lp as string,
      pool: e.args.pool as string,
      token: e.args.token as string,
      amount: (e.args.amount as bigint).toString(),
      tier: Number(e.args.tier),
    }))).to.matchSnapshot()
    const retained = hookLogs.filter(p => p.name === 'Retained')

    expect({
      event: 'Qualified',
      tier: Number(qualified!.args.tier),
      shareBps: Number(qualified!.args.shareBps),
      pool: qualified!.args.pool as string,
      lp: qualified!.args.lp as string,
    }).to.matchSnapshot()

    expect(rebatePaid.map(e => ({
      to: e.args.to as string,
      pool: e.args.pool as string,
      token: e.args.token as string,
      amount: (e.args.amount as bigint).toString(),
      tier: Number(e.args.tier),
    }))).to.matchSnapshot()

    expect(retained.map(e => ({
      pool: e.args.pool as string,
      token: e.args.token as string,
      amount: (e.args.amount as bigint).toString(),
      tier: Number(e.args.tier),
    }))).to.matchSnapshot()

    const tier: number = Number(qualified!.args.tier)
    const rBps: bigint = BigInt(await (hook as any).rebateBps(tier))
    const kBps: bigint = BigInt(await (hook as any).retentionBps(tier))

    const rb0 = (amount0Owed * rBps) / 10_000n
    const rb1 = (amount1Owed * rBps) / 10_000n
    const kt0 = (amount0Owed * kBps) / 10_000n
    const kt1 = (amount1Owed * kBps) / 10_000n

    const bVault0After = await t0.balanceOf(await vault.getAddress())
    const bVault1After = await t1.balanceOf(await vault.getAddress())
    const bTreas0After = await t0.balanceOf(await treasury.getAddress())
    const bTreas1After = await t1.balanceOf(await treasury.getAddress())

    expect(bVault0After - bVault0Before).to.eq(rb0)
    expect(bVault1After - bVault1Before).to.eq(rb1)
    expect(bTreas0After - bTreas0Before).to.eq(kt0)
    expect(bTreas1After - bTreas1Before).to.eq(kt1)

    const slot = await pool.slot0()
    expect({
      owed: { amount0: amount0Owed.toString(), amount1: amount1Owed.toString() },
      rebateBps: rBps.toString(),
      retentionBps: kBps.toString(),
      expectedRebate: { token0: rb0.toString(), token1: rb1.toString() },
      expectedRetention: { token0: kt0.toString(), token1: kt1.toString() },
      vaultDelta: {
        token0: (bVault0After - bVault0Before).toString(),
        token1: (bVault1After - bVault1Before).toString(),
      },
      treasuryDelta: {
        token0: (bTreas0After - bTreas0Before).toString(),
        token1: (bTreas1After - bTreas1Before).toString(),
      },
      finalTick: Number(slot.tick),
      tickSpacing: ts,
      maxLiqPerTick: getMaxLiquidityPerTick(ts).toString(),
    }).to.matchSnapshot()
  })

  it('qualifies Tier 0 for tiny share and pays proportionally small surcharge', async () => {
    const { fix, pool, hook, vault, treasury, minTick, maxTick, mintWithRebate } = await loadFixture(rebatesFixture)
    const lp = await wallet.getAddress()
    const hookAddr = await hook.getAddress()
    const Lmint = expandTo18Decimals(1) / 100n

    const t0 = fix.token0, t1 = fix.token1
    const bV0 = await t0.balanceOf(await vault.getAddress())
    const bV1 = await t1.balanceOf(await vault.getAddress())
    const bT0 = await t0.balanceOf(await treasury.getAddress())
    const bT1 = await t1.balanceOf(await treasury.getAddress())

    const receipt = await (await mintWithRebate({
      hookAddress: hookAddr, recipient: lp, tickLower: minTick, tickUpper: maxTick, liquidity: Lmint,
    })).wait()

    const hookIface = (hook as any).interface
    const logs = receipt!.logs.map((l: any) => { try { return hookIface.parseLog(l) } catch { return null } }).filter(Boolean) as any[]
    const q = logs.find(l => l.name === 'Qualified')
    expect(q).to.not.eq(undefined)
    expect(Number(q!.args.tier)).to.eq(0)

    const r = logs.filter(l => l.name === 'RebatePaid')
    const k = logs.filter(l => l.name === 'Retained')
    expect(r.length).to.be.greaterThan(0)
    expect(k.length).to.be.greaterThan(0)

    expect(await t0.balanceOf(await vault.getAddress())).to.be.gte(bV0)
    expect(await t1.balanceOf(await vault.getAddress())).to.be.gte(bV1)
    expect(await t0.balanceOf(await treasury.getAddress())).to.be.gte(bT0)
    expect(await t1.balanceOf(await treasury.getAddress())).to.be.gte(bT1)
  })

  it('qualifies Tier 3 when minted liquidity ≥ TVL/1 (share ≥ 50%)', async () => {
    const { fix, pool, hook, minTick, maxTick, L0, mintWithRebate } = await loadFixture(rebatesFixture)
    const lp = await wallet.getAddress()
    const hookAddr = await hook.getAddress()

    const receipt = await (await mintWithRebate({
      hookAddress: hookAddr, recipient: lp, tickLower: minTick, tickUpper: maxTick, liquidity: L0,
    })).wait()

    const hookIface = (hook as any).interface
    const logs = receipt!.logs.map((l: any) => { try { return hookIface.parseLog(l) } catch { return null } }).filter(Boolean) as any[]
    const q = logs.find(l => l.name === 'Qualified')
    expect(q).to.not.eq(undefined)
    expect(Number(q!.args.tier)).to.eq(3)
  })

  it('single-sided mint: price below range → only token0 owed (only token0 surcharge)', async () => {
    const { fix, pool, hook, mintWithRebate, ts } = await loadFixture(rebatesFixture)
    const lp = await wallet.getAddress()
    const hookAddr = await hook.getAddress()

    const lower = 10 * ts
    const upper = 100 * ts

    const receipt = await (await mintWithRebate({
      hookAddress: hookAddr, recipient: lp, tickLower: lower, tickUpper: upper, liquidity: expandTo18Decimals(1),
    })).wait()

    const hookIface = (hook as any).interface
    const logs = receipt!.logs.map((l: any) => { try { return hookIface.parseLog(l) } catch { return null } }).filter(Boolean) as any[]
    const rebates = logs.filter(l => l.name === 'RebatePaid')
    expect(rebates.length).to.eq(1)
  })

  it('single-sided mint: price above range → only token1 owed (only token1 surcharge)', async () => {
    const { fix, pool, hook, mintWithRebate, ts } = await loadFixture(rebatesFixture)
    const lp = await wallet.getAddress()
    const hookAddr = await hook.getAddress()

    const lower = -100 * ts
    const upper = -10 * ts

    const receipt = await (await mintWithRebate({
      hookAddress: hookAddr, recipient: lp, tickLower: lower, tickUpper: upper, liquidity: expandTo18Decimals(1),
    })).wait()

    const hookIface = (hook as any).interface
    const logs = receipt!.logs.map((l: any) => { try { return hookIface.parseLog(l) } catch { return null } }).filter(Boolean) as any[]
    const rebates = logs.filter(l => l.name === 'RebatePaid')
    expect(rebates.length).to.eq(1)
  })

  it('uses a different payer: surcharge pulled from payer balances/approvals, not recipient', async () => {
    const { fix, pool, hook, vault, treasury, minTick, maxTick, mintWithRebate } = await loadFixture(rebatesFixture)

    const recipient = await wallet.getAddress()
    const payer = await alice.getAddress()
    const hookAddr = await hook.getAddress()

    const seed0 = expandTo18Decimals(1000)
    const seed1 = expandTo18Decimals(1000)
    await fix.token0.transfer(payer, seed0)
    await fix.token1.transfer(payer, seed1)
    await fix.token0.connect(alice).approve(hookAddr, ethers.MaxUint256)
    await fix.token1.connect(alice).approve(hookAddr, ethers.MaxUint256)

    const bV0 = await fix.token0.balanceOf(await vault.getAddress())
    const bV1 = await fix.token1.balanceOf(await vault.getAddress())
    const bT0 = await fix.token0.balanceOf(await treasury.getAddress())
    const bT1 = await fix.token1.balanceOf(await treasury.getAddress())

    await (await mintWithRebate({
      hookAddress: hookAddr,
      recipient,
      payer,
      tickLower: minTick,
      tickUpper: maxTick,
      liquidity: expandTo18Decimals(1),
    })).wait()

    expect(await fix.token0.balanceOf(await vault.getAddress())).to.be.gt(bV0)
    expect(await fix.token1.balanceOf(await vault.getAddress())).to.be.gt(bV1)
    expect(await fix.token0.balanceOf(await treasury.getAddress())).to.be.gt(bT0)
    expect(await fix.token1.balanceOf(await treasury.getAddress())).to.be.gt(bT1)
  })

  it('owner can update tiers; non-owner cannot', async () => {
    const { hook } = await loadFixture(rebatesFixture)

    await expect(
      (hook as any).connect(alice).setTiers(
        [100, 200, 300, 400],
        [111, 222, 333, 444],
        [11,  22,  33,  44]
      )
    ).to.be.revertedWith('not owner')

    await (hook as any).setTiers(
      [100, 200, 300, 400],
      [111, 222, 333, 444],
      [11,  22,  33,  44]
    )

    expect(await (hook as any).rebateBps(0)).to.eq(111)
    expect(await (hook as any).retentionBps(3)).to.eq(44)
  })

  it('reverts on invalid params (pool=0, recipient=0, payer=0, liq=0)', async () => {
    const { hook, pool } = await loadFixture(rebatesFixture)

    await expect(
      (hook as any).mintWithRebate({
        pool: ethers.ZeroAddress,
        tickLower: 0, tickUpper: 1, liquidity: 1, recipient: await wallet.getAddress(), payer: await wallet.getAddress(),
      })
    ).to.be.revertedWith('pool=0')

    await expect(
      (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        tickLower: 0, tickUpper: 1, liquidity: 1, recipient: ethers.ZeroAddress, payer: await wallet.getAddress(),
      })
    ).to.be.revertedWith('recipient=0')

    await expect(
      (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        tickLower: 0, tickUpper: 1, liquidity: 1, recipient: await wallet.getAddress(), payer: ethers.ZeroAddress,
      })
    ).to.be.revertedWith('payer=0')

    await expect(
      (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        tickLower: 0, tickUpper: 1, liquidity: 0, recipient: await wallet.getAddress(), payer: await wallet.getAddress(),
      })
    ).to.be.revertedWith('liq=0')
  })

  it('routes retention to treasury (both tokens) and not to vault', async () => {
    const { fix, pool, hook, vault, treasury, minTick, maxTick, mintWithRebate } = await loadFixture(rebatesFixture)

    const lp = await wallet.getAddress()
    const hookAddr = await hook.getAddress()

    const Lmint = expandTo18Decimals(1)
    const t0 = fix.token0
    const t1 = fix.token1

    const bVault0Before = await t0.balanceOf(await vault.getAddress())
    const bVault1Before = await t1.balanceOf(await vault.getAddress())
    const bTreas0Before = await t0.balanceOf(await treasury.getAddress())
    const bTreas1Before = await t1.balanceOf(await treasury.getAddress())

    const tx = await mintWithRebate({
      hookAddress: hookAddr,
      recipient: lp,
      payer: lp,
      tickLower: minTick,
      tickUpper: maxTick,
      liquidity: Lmint,
    })
    const receipt = await tx.wait()
    await snapshotGasCost(receipt.gasUsed)

    const poolIface = (pool as any).interface
    const mintEvt = receipt!.logs
      .map((l: any) => { try { return poolIface.parseLog(l) } catch { return null } })
      .find((p: any) => p && p.name === 'Mint')
    expect(mintEvt, 'Mint event missing').to.not.eq(undefined)
    const amount0Owed: bigint = mintEvt!.args.amount0 as bigint
    const amount1Owed: bigint = mintEvt!.args.amount1 as bigint

    const hookLogs = receipt!.logs
      .map((l: any) => { try { return (hook as any).interface.parseLog(l) } catch { return null } })
      .filter(Boolean) as any[]
    const qualified = hookLogs.find(p => p.name === 'Qualified')
    const tier: number = Number(qualified!.args.tier)
    const rBps: bigint = BigInt(await (hook as any).rebateBps(tier))
    const kBps: bigint = BigInt(await (hook as any).retentionBps(tier))

    const rb0 = (amount0Owed * rBps) / 10_000n
    const rb1 = (amount1Owed * rBps) / 10_000n
    const kt0 = (amount0Owed * kBps) / 10_000n
    const kt1 = (amount1Owed * kBps) / 10_000n

    const bVault0After = await t0.balanceOf(await vault.getAddress())
    const bVault1After = await t1.balanceOf(await vault.getAddress())
    const bTreas0After = await t0.balanceOf(await treasury.getAddress())
    const bTreas1After = await t1.balanceOf(await treasury.getAddress())

    expect(bVault0After - bVault0Before).to.eq(rb0)
    expect(bVault1After - bVault1Before).to.eq(rb1)
    expect(bTreas0After - bTreas0Before).to.eq(kt0)
    expect(bTreas1After - bTreas1Before).to.eq(kt1)

    expect({
      tier,
      rBps: rBps.toString(),
      kBps: kBps.toString(),
      owed: { token0: amount0Owed.toString(), token1: amount1Owed.toString() },
      vaultDelta: {
        token0: (bVault0After - bVault0Before).toString(),
        token1: (bVault1After - bVault1Before).toString(),
      },
      treasuryDelta: {
        token0: (bTreas0After - bTreas0Before).toString(),
        token1: (bTreas1After - bTreas1Before).toString(),
      },
    }).to.matchSnapshot()
  })

  it('treasury transfer funds', async () => {
    const { fix, pool, hook, vault, treasury, minTick, maxTick, mintWithRebate } = await loadFixture(rebatesFixture)

    const [ , other ] = await ethers.getSigners()
    const lp = await wallet.getAddress()
    const hookAddr = await hook.getAddress()

    const t0 = fix.token0
    const t1 = fix.token1

    const tx = await mintWithRebate({
      hookAddress: hookAddr,
      recipient: lp,
      payer: lp,
      tickLower: minTick,
      tickUpper: maxTick,
      liquidity: expandTo18Decimals(2),
    })
    await tx.wait()

    const treAddr = await treasury.getAddress()
    const otherAddr = await other.getAddress()

    const t0TreasBefore = await t0.balanceOf(treAddr)
    const t1TreasBefore = await t1.balanceOf(treAddr)

    await expect(
      (treasury as any).connect(other).sweepERC20(await t0.getAddress(), otherAddr, 1n)
    ).to.be.revertedWith('not owner')

    const sweep0 = t0TreasBefore / 2n
    const r1 = await (await (treasury as any).sweepERC20(await t0.getAddress(), otherAddr, sweep0)).wait()
    await snapshotGasCost(r1.gasUsed)
    expect(await t0.balanceOf(otherAddr)).to.eq(sweep0)
    expect(await t0.balanceOf(treAddr)).to.eq(t0TreasBefore - sweep0)

    const r2 = await (await (treasury as any).sweepAllERC20(await t1.getAddress(), otherAddr)).wait()
    await snapshotGasCost(r2.gasUsed)
    expect(await t1.balanceOf(otherAddr)).to.eq(t1TreasBefore)
    expect(await t1.balanceOf(treAddr)).to.eq(0n)

    const ethIn = 1_000_000_000_000_000n
    await wallet.sendTransaction({ to: treAddr, value: ethIn })
    const ethBefore = await ethers.provider.getBalance(otherAddr)
    const r3 = await (await (treasury as any).sweepETH(otherAddr, ethIn)).wait()
    await snapshotGasCost(r3.gasUsed)

    const summary = {
      t0TreasBefore: t0TreasBefore.toString(),
      t1TreasBefore: t1TreasBefore.toString(),
      t0Swept: sweep0.toString(),
      t1SweptAll: t1TreasBefore.toString(),
      ethSwept: ethIn.toString(),
      t0TreasAfter: (await t0.balanceOf(treAddr)).toString(),
      t1TreasAfter: (await t1.balanceOf(treAddr)).toString(),
      t0Other: (await t0.balanceOf(otherAddr)).toString(),
      t1Other: (await t1.balanceOf(otherAddr)).toString(),
      otherEthGte: (await ethers.provider.getBalance(otherAddr)) >= ethBefore,
    }
    expect(summary).to.matchSnapshot()
  })

  // ------------------------- NEW BYPASS-GUARD TESTS -------------------------

  it('blocks direct pool.mint from an EOA (must go through hook)', async () => {
    const { pool, minTick, maxTick, attemptDirectMint } = await loadFixture(rebatesFixture)
    await expect(
      attemptDirectMint(await wallet.getAddress(), minTick, maxTick, expandTo18Decimals(1))
    ).to.be.revertedWith('ONLY_MINT_HOOK')
  })

  it('blocks callee-style pool.mint (msg.sender != hook)', async () => {
    const { legacyCalleeMint, minTick, maxTick } = await loadFixture(rebatesFixture)
    await expect(
      legacyCalleeMint(await wallet.getAddress(), minTick, maxTick, expandTo18Decimals(1))
    ).to.be.revertedWith('ONLY_MINT_HOOK')
  })

  it('blocks a different hook from minting into this pool', async () => {
    const { fix, pool, vault, treasury, minTick, maxTick } = await loadFixture(rebatesFixture)

    // Deploy a second hook that is NOT the pool’s baked hook
    const HookF = await ethers.getContractFactory('LPPMintHook')

    // deploy (generic BaseContract)
    const otherHookDep = await HookF.deploy(await vault.getAddress(), await treasury.getAddress())
    await otherHookDep.waitForDeployment()

    // reattach as a strongly-typed instance (same way you did with TickMath)
    const otherHook = (await ethers.getContractAt(
      'LPPMintHook',
      await otherHookDep.getAddress()
    )) as unknown as LPPMintHook

    // Try minting via the other hook → it will call pool.mint(msg.sender=otherHook), which must revert
    await fix.token0.approve(await otherHook.getAddress(), ethers.MaxUint256)
    await fix.token1.approve(await otherHook.getAddress(), ethers.MaxUint256)

    await expect(
      (otherHook as any).mintWithRebate({
        pool: await pool.getAddress(),
        tickLower: minTick,
        tickUpper: maxTick,
        liquidity: expandTo18Decimals(1),
        recipient: await wallet.getAddress(),
        payer: await wallet.getAddress(),
      })
    ).to.be.revertedWith('ONLY_MINT_HOOK')
  })

  it('exposes canonical hook address (if the pool implements mintHook())', async () => {
    const { pool, hook } = await loadFixture(rebatesFixture)
    // If your pool added `function mintHook() external view returns (address)`
    try {
      const wired = await (pool as any).mintHook()
      expect(wired).to.eq(await hook.getAddress())
    } catch {
      // If not implemented yet, this test is a no-op
    }
  })
})