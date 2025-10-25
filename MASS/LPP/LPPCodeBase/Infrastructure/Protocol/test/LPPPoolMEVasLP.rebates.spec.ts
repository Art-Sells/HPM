// test/LPPPoolMEVasLP.rebates.spec.ts
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

// keep only what's definitely generated in ../typechain-types/protocol
import type { MockTimeLPPPool } from '../typechain-types/protocol'

describe('MEV-as-LP Rebates — mintWithRebate', () => {
  let wallet: HardhatEthersSigner

  before(async () => {
    ;[wallet] = (await ethers.getSigners()) as HardhatEthersSigner[]
  })

  async function rebatesFixture() {
    // Base protocol fixture (tokens, factory, callee, etc.)
    const fix = await (poolFixture as any)([wallet], ethers.provider)
    const pool: MockTimeLPPPool = await fix.createPool(FeeAmount.ZERO, TICK_SPACINGS[FeeAmount.ZERO])

    // Initialize @ price = 1.0
    await pool.initialize(encodePriceSqrt(1n, 1n))

    // Baseline TVL to make shareBps meaningful
    const { mint } = createPoolFunctions({
      supplicateTarget: fix.supplicateTargetCallee,
      token0: fix.token0,
      token1: fix.token1,
      pool,
    })
    const ts = TICK_SPACINGS[FeeAmount.ZERO]
    const minTick = getMinTick(ts)
    const maxTick = getMaxTick(ts)

    const L0 = expandTo18Decimals(10)
    await mint(await wallet.getAddress(), minTick, maxTick, L0)

    // Deploy vault + treasury (untyped to avoid missing typechain exports)
    const RebateVaultF = await ethers.getContractFactory('LPPRebateVault')
    const vault: any = await RebateVaultF.deploy(await wallet.getAddress())
    await vault.waitForDeployment()

    let treasury: any
    try {
      const T1 = await ethers.getContractFactory('LPPTreasury')
      treasury = await T1.deploy(await wallet.getAddress())
      await treasury.waitForDeployment()
    } catch {
      const T0 = await ethers.getContractFactory('LPPTreasury')
      treasury = await T0.deploy()
      await treasury.waitForDeployment()
    }

    // Deploy the hook
    const HookF = await ethers.getContractFactory('LPPMintHook')
    const hook: any = await HookF.deploy(await vault.getAddress(), await treasury.getAddress())
    await hook.waitForDeployment()

    // Helper
    const { mintWithRebate } = createRebateFunctions({
      pool,
      token0: fix.token0,
      token1: fix.token1,
    })

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
    }
  }

  it('mints with surcharge, emits events, transfers rebate/retention, and posts snapshots', async () => {
    const {
      fix,
      pool,
      hook,
      vault,
      treasury,
      minTick,
      maxTick,
      L0,
      mintWithRebate,
      ts,
    } = await loadFixture(rebatesFixture)

    const lpAddr = await wallet.getAddress()
    const hookAddr = await hook.getAddress()

    // Target ~10–15% share to land in T1/T2 depending on table
    const Lmint = expandTo18Decimals(15) / 10n // 1.5e18

    const t0 = fix.token0
    const t1 = fix.token1

    // Balances before
    const bVault0Before = await t0.balanceOf(await vault.getAddress())
    const bVault1Before = await t1.balanceOf(await vault.getAddress())
    const bTreas0Before = await t0.balanceOf(await treasury.getAddress())
    const bTreas1Before = await t1.balanceOf(await treasury.getAddress())

    // Execute
    const tx = await mintWithRebate({
      hookAddress: hookAddr,
      recipient: lpAddr,
      payer: lpAddr,
      tickLower: minTick,
      tickUpper: maxTick,
      liquidity: Lmint,
    })
    const receipt = await tx.wait()

    // --- GAS SNAPSHOT ---
    await snapshotGasCost(receipt.gasUsed)

    // Parse pool Mint event for owed amounts
    const poolIface = (pool as any).interface
    const mintEvt = receipt!.logs
      .map((l: any) => { try { return poolIface.parseLog(l) } catch { return null } })
      .find((p: any) => p && p.name === 'Mint')
    expect(mintEvt, 'Mint event missing').to.not.eq(undefined)
    const amount0Owed: bigint = mintEvt!.args.amount0 as bigint
    const amount1Owed: bigint = mintEvt!.args.amount1 as bigint

    // Parse hook events
    const hookIface = (hook as any).interface
    const hookLogs = receipt!.logs.map((l: any) => { try { return hookIface.parseLog(l) } catch { return null } }).filter(Boolean) as any[]

    const qualified = hookLogs.find(p => p.name === 'Qualified')
    expect(qualified, 'Qualified event missing').to.not.eq(undefined)

    const rebatePaid = hookLogs.filter(p => p.name === 'RebatePaid')
    const retained = hookLogs.filter(p => p.name === 'Retained')

    // Snapshot #1: Qualified event
    expect({
      event: 'Qualified',
      tier: Number(qualified!.args.tier),
      shareBps: Number(qualified!.args.shareBps),
      pool: qualified!.args.pool as string,
      lp: qualified!.args.lp as string,
    }).to.matchSnapshot()

    // Snapshot #2: RebatePaid events
    expect(rebatePaid.map(e => ({
      to: e.args.to as string,
      pool: e.args.pool as string,
      token: e.args.token as string,
      amount: (e.args.amount as bigint).toString(),
      tier: Number(e.args.tier),
    }))).to.matchSnapshot()

    // Snapshot #3: Retained events
    expect(retained.map(e => ({
      pool: e.args.pool as string,
      token: e.args.token as string,
      amount: (e.args.amount as bigint).toString(),
      tier: Number(e.args.tier),
    }))).to.matchSnapshot()

    // Compute expected surcharge
    const tier: number = Number(qualified!.args.tier)
    const rBps: bigint = BigInt(await (hook as any).rebateBps(tier))
    const kBps: bigint = BigInt(await (hook as any).retentionBps(tier))

    const rb0 = (amount0Owed * rBps) / 10_000n
    const rb1 = (amount1Owed * rBps) / 10_000n
    const kt0 = (amount0Owed * kBps) / 10_000n
    const kt1 = (amount1Owed * kBps) / 10_000n

    // Balances after
    const bVault0After = await t0.balanceOf(await vault.getAddress())
    const bVault1After = await t1.balanceOf(await vault.getAddress())
    const bTreas0After = await t0.balanceOf(await treasury.getAddress())
    const bTreas1After = await t1.balanceOf(await treasury.getAddress())

    // Assertions
    expect(bVault0After - bVault0Before).to.eq(rb0)
    expect(bVault1After - bVault1Before).to.eq(rb1)
    expect(bTreas0After - bTreas0Before).to.eq(kt0)
    expect(bTreas1After - bTreas1Before).to.eq(kt1)

    // Snapshot #4: Summary view (math + balances + pool state)
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
})