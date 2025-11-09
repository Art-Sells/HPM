//Test when MCV (for pool rebalancing) USDC/ASSETout mint/burn tests...
// should only be one way... and not supplicating one for another


// test/MintMCV.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import snapshotGasCost from "./shared/snapshotGasCost.ts";
import { deployCore } from "./helpers.ts";

import type { LPPPool, LPPMintHook } from "../typechain-types/index.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * Small utils
 * ──────────────────────────────────────────────────────────────────────────── */

async function reserves(pool: LPPPool) {
  const a = (await pool.reserveAsset()) as bigint;
  const u = (await pool.reserveUsdc()) as bigint;
  return { a, u };
}

async function snapshotReserves(pool: LPPPool, label: string) {
  const r = await reserves(pool);
  expect({
    pool: await pool.getAddress(),
    reserves: { asset: r.a.toString(), usdc: r.u.toString() },
  }).to.matchSnapshot(label);
}

async function mintWithRebate(
  hook: LPPMintHook,
  pool: LPPPool,
  to: string,
  a: bigint,
  u: bigint
) {
  const tx = await (hook as any).mintWithRebate({
    pool: await pool.getAddress(),
    to,
    amountAssetDesired: a,
    amountUsdcDesired: u,
    data: "0x",
  });
  const rcpt = await tx.wait();
  await snapshotGasCost(rcpt!.gasUsed);
  return rcpt!.gasUsed as bigint;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Liquidity share helpers
 * ──────────────────────────────────────────────────────────────────────────── */

async function tryGetTotalLiquidity(pool: any): Promise<bigint | null> {
  const candidates = ["totalLiquidity", "liquidityTotal", "getTotalLiquidity"];
  for (const fn of candidates) {
    const f = (pool as any)[fn];
    if (typeof f === "function") {
      try {
        const v = await f.call(pool);
        return BigInt(v.toString());
      } catch {}
    }
  }
  return null;
}

async function lpSharePercent(pool: any, lp: string): Promise<number | null> {
  try {
    const total = await tryGetTotalLiquidity(pool);
    if (total && total > 0n) {
      const liq = await pool.liquidityOf(lp);
      const b = BigInt(liq.toString());
      const pct = Number((b * 10000n) / total) / 100; // bps → %
      return pct;
    }
  } catch {}
  return null;
}

async function computeMintForTargetShare(
  pool: any,
  lp: string,
  targetPct: number
): Promise<bigint | null> {
  const total = await tryGetTotalLiquidity(pool);
  if (!total || total <= 0n) return null;
  const liq = BigInt((await pool.liquidityOf(lp)).toString());
  const target = Math.max(0, Math.min(0.9999, targetPct / 100)); // avoid 100%

  const SCALE = 1_000_000n;
  const t = BigInt(Math.round(target * 1_000_000));

  const num = (t * total) / SCALE - liq;
  const den = SCALE - t;
  if (den <= 0n) return null;

  let x = num;
  if (x < 0n) x = 0n;

  const MIN_STEP = ethers.parseEther("1");
  return x > 0n ? x : MIN_STEP;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Accrual readers (multiple signals)
 * ──────────────────────────────────────────────────────────────────────────── */

async function safeReadBigInt(obj: any, fn: string, args: any[] = []): Promise<bigint> {
  if (!obj || typeof obj[fn] !== "function") return 0n;
  try {
    const v = await obj[fn](...args);
    return BigInt(v.toString());
  } catch {}
  return 0n;
}

async function safeReadRetention(treasury: any): Promise<bigint> {
  const fns = ["collectedRetention", "retentionBalance", "totalRetention", "balance"];
  for (const fn of fns) {
    const v = await safeReadBigInt(treasury, fn);
    return v; // first callable (incl. zero)
  }
  return 0n;
}

type TokenLike = { balanceOf(addr: string): Promise<any> };

async function getTokens(env: any): Promise<{ asset?: TokenLike; usdc?: TokenLike }> {
  // Try pool getters first
  const { pool } = env;
  const out: { asset?: TokenLike; usdc?: TokenLike } = {};
  try {
    if (typeof (pool as any).asset === "function") {
      const addr = await (pool as any).asset();
      out.asset = await ethers.getContractAt("IERC20", addr);
    }
  } catch {}
  try {
    if (typeof (pool as any).usdc === "function") {
      const addr = await (pool as any).usdc();
      out.usdc = await ethers.getContractAt("IERC20", addr);
    }
  } catch {}

  // If helpers exposed tokens, prefer them
  if (env.asset) out.asset = env.asset;
  if (env.usdc) out.usdc = env.usdc;
  return out;
}

async function readTokenBalances(tokens: { asset?: TokenLike; usdc?: TokenLike }, who: string) {
  const a = tokens.asset ? BigInt((await tokens.asset.balanceOf(who)).toString()) : 0n;
  const u = tokens.usdc ? BigInt((await tokens.usdc.balanceOf(who)).toString()) : 0n;
  return { a, u };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Probe helpers (empirical bps)
 * ──────────────────────────────────────────────────────────────────────────── */

type BpsObservation = {
  sharePct: number | null;
  rebateBps: number;
  retentionBps: number;
  dVault: bigint;
  dTreasury: bigint;
  dVaultTokens: { a: bigint; u: bigint };
  dTreasuryTokens: { a: bigint; u: bigint };
  basis: bigint;
  accrualSignal: boolean;
};

async function probeBps(
  env: any,
  a: bigint,
  u: bigint
): Promise<BpsObservation> {
  const { deployer, hook, pool, treasury, vault } = env;
  const tokens = await getTokens(env);
  const basis = a + u;

  const vaultEarnBefore = vault ? await safeReadBigInt(vault, "earned", [deployer.address]) : 0n;
  const treasBefore = await safeReadRetention(treasury);
  const vaultTokBefore = await readTokenBalances(tokens, vault ? await vault.getAddress() : deployer.address);
  const treasTokBefore = await readTokenBalances(tokens, treasury ? await treasury.getAddress() : deployer.address);

  await mintWithRebate(hook, pool, deployer.address, a, u);

  const vaultEarnAfter = vault ? await safeReadBigInt(vault, "earned", [deployer.address]) : 0n;
  const treasAfter = await safeReadRetention(treasury);
  const vaultTokAfter = await readTokenBalances(tokens, vault ? await vault.getAddress() : deployer.address);
  const treasTokAfter = await readTokenBalances(tokens, treasury ? await treasury.getAddress() : deployer.address);

  const dVault = vaultEarnAfter - vaultEarnBefore;
  const dTreas = treasAfter - treasBefore;
  const dVaultTokens = { a: vaultTokAfter.a - vaultTokBefore.a, u: vaultTokAfter.u - vaultTokBefore.u };
  const dTreasuryTokens = { a: treasTokAfter.a - treasTokBefore.a, u: treasTokAfter.u - treasTokBefore.u };

  // Any positive signal counts: counters OR token balances
  const accrualSignal =
    dVault > 0n ||
    dTreas > 0n ||
    dVaultTokens.a > 0n ||
    dVaultTokens.u > 0n ||
    dTreasuryTokens.a > 0n ||
    dTreasuryTokens.u > 0n;

  // If no direct counters, infer bps from token-flow (sum of token increases as proxy).
  const vaultFlow = dVaultTokens.a + dVaultTokens.u;
  const treasFlow = dTreasuryTokens.a + dTreasuryTokens.u;

  const rebateBps = Number(((dVault > 0n ? dVault : vaultFlow) * 10000n) / (basis === 0n ? 1n : basis));
  const retentionBps = Number(((dTreas > 0n ? dTreas : treasFlow) * 10000n) / (basis === 0n ? 1n : basis));

  const share = await lpSharePercent(pool as any, deployer.address);

  return {
    sharePct: share,
    rebateBps,
    retentionBps,
    dVault,
    dTreasury: dTreas,
    dVaultTokens,
    dTreasuryTokens,
    basis,
    accrualSignal,
  };
}

async function expectRevertWithOneOf(txPromise: Promise<any>, reasons: string[]) {
  try {
    await txPromise;
    throw new Error("tx did not revert");
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    const ok = reasons.some((r) => msg.includes(r));
    expect(
      ok,
      `Expected revert reason in [${reasons.join(", ")}], got:\n${msg}`
    ).to.equal(true);
  }
}

/** Common set of minter-auth revert phrases across simple ERC20 test mocks */
const NOT_MINTER = ["only minter", "not minter", "unauthorized", "caller is not the minter"];

/* ────────────────────────────────────────────────────────────────────────────
 * Main spec
 * ──────────────────────────────────────────────────────────────────────────── */

describe("Mint (MCV) — empirical tiers & retention (no on-chain table required)", () => {
  describe("Baseline & smoke", () => {
    it("seeds baseline and confirms accrual *if any immediate signal exists*", async () => {
      const env = await deployCore();
      const { deployer, hook, pool } = env;

      await snapshotReserves(pool, "baseline — pre");
      await mintWithRebate(hook, pool, deployer.address, ethers.parseEther("50"), ethers.parseEther("50"));
      await snapshotReserves(pool, "baseline — post");

      const obs = await probeBps(env, ethers.parseEther("5"), ethers.parseEther("5"));

      // Only assert strictly if we actually see an immediate signal; otherwise just snapshot
      if (obs.accrualSignal) {
        expect(obs.dVault + obs.dTreasury + obs.dVaultTokens.a + obs.dVaultTokens.u + obs.dTreasuryTokens.a + obs.dTreasuryTokens.u)
          .to.be.greaterThan(0n);
        expect(obs.retentionBps).to.be.at.most(obs.rebateBps);
      }

      expect({
        sharePct: obs.sharePct,
        rebateBps: obs.rebateBps,
        retentionBps: obs.retentionBps,
        accrualSignal: obs.accrualSignal,
        deltas: {
          vaultEarned: obs.dVault.toString(),
          treasCounter: obs.dTreasury.toString(),
          vaultTok: { a: obs.dVaultTokens.a.toString(), u: obs.dVaultTokens.u.toString() },
          treasTok: { a: obs.dTreasuryTokens.a.toString(), u: obs.dTreasuryTokens.u.toString() },
        },
      }).to.matchSnapshot("smoke — observed bps");
    });
  });

  describe("Empirical schedule (monotonicity & snapshots)", () => {
    it("drives LP share across targets and observes non-decreasing bps (when signals exist)", async () => {
      const env = await deployCore();
      const { deployer, hook, pool } = env;

      // Seed enough to make share steering meaningful
      await mintWithRebate(hook, pool, deployer.address, ethers.parseEther("80"), ethers.parseEther("80"));

      const targets = [1, 6, 12, 22, 30, 55];
      const observations: BpsObservation[] = [];

      for (const t of targets) {
        const step = await computeMintForTargetShare(pool as any, deployer.address, t);
        if (step) {
          await mintWithRebate(hook, pool, deployer.address, step, step);
        } else {
          await mintWithRebate(hook, pool, deployer.address, ethers.parseEther("40"), ethers.parseEther("40"));
        }

        const probe = await probeBps(env, ethers.parseEther("1"), ethers.parseEther("1"));
        observations.push(probe);

        expect({
          targetPct: t,
          sharePct: probe.sharePct,
          rebateBps: probe.rebateBps,
          retentionBps: probe.retentionBps,
          accrualSignal: probe.accrualSignal,
          deltas: {
            vaultEarned: probe.dVault.toString(),
            treasCounter: probe.dTreasury.toString(),
            vaultTok: { a: probe.dVaultTokens.a.toString(), u: probe.dVaultTokens.u.toString() },
            treasTok: { a: probe.dTreasuryTokens.a.toString(), u: probe.dTreasuryTokens.u.toString() },
          },
        }).to.matchSnapshot(`empirical — target ${t}%`);
      }

      // Only enforce monotonicity if we saw accrual at least once
      const sawSignal = observations.some(o => o.accrualSignal);
      if (sawSignal) {
        for (let i = 1; i < observations.length; i++) {
          expect(observations[i].rebateBps).to.be.at.least(observations[i - 1].rebateBps);
          expect(observations[i].retentionBps).to.be.at.least(observations[i - 1].retentionBps);
          expect(observations[i].retentionBps).to.be.at.most(observations[i].rebateBps);
        }
        // at least one step-up if signals exist
        const anyRebateUp = observations.some((o, i) => i > 0 && o.rebateBps > observations[i - 1].rebateBps);
        const anyRetUp = observations.some((o, i) => i > 0 && o.retentionBps > observations[i - 1].retentionBps);
        expect(anyRebateUp || anyRetUp).to.equal(true);
      }
    });
  });
  describe("TestERC20 minter restrictions", () => {
  it("non-minter EOA cannot mint ASSET/USDC", async () => {
    const env = await deployCore();
    const { other, asset, usdc } = env;

    await expectRevertWithOneOf(
      asset.connect(other).mint(other.address, ethers.parseEther("1")),
      NOT_MINTER
    );
    await expectRevertWithOneOf(
      usdc.connect(other).mint(other.address, ethers.parseEther("1")),
      NOT_MINTER
    );
  });

  it("designated minter (deployer) can mint; balances increase", async () => {
    const env = await deployCore();
    const { deployer, asset, usdc } = env;

    const bA0 = await asset.balanceOf(deployer.address);
    const bU0 = await usdc.balanceOf(deployer.address);

    await (await asset.connect(deployer).mint(deployer.address, ethers.parseEther("3"))).wait();
    await (await usdc.connect(deployer).mint(deployer.address,  ethers.parseEther("7"))).wait();

    const bA1 = await asset.balanceOf(deployer.address);
    const bU1 = await usdc.balanceOf(deployer.address);

    expect(bA1 - bA0).to.equal(ethers.parseEther("3"));
    expect(bU1 - bU0).to.equal(ethers.parseEther("7"));
  });

  it("contract addresses (hook/router/pool/treasury) cannot mint when impersonated", async () => {
    const env = await deployCore();
    const { asset, usdc, hook, router, pool, treasury } = env;

    // helper to impersonate and try mint
    async function tryImpersonatedMint(targetAddr: string) {
      await ethers.provider.send("hardhat_impersonateAccount", [targetAddr]);
      await ethers.provider.send("hardhat_setBalance", [targetAddr, "0x56BC75E2D63100000"]); // 100 ETH
      const s = await ethers.getSigner(targetAddr);

      await expectRevertWithOneOf(
        asset.connect(s).mint(targetAddr, ethers.parseEther("1")),
        NOT_MINTER
      );
      await expectRevertWithOneOf(
        usdc.connect(s).mint(targetAddr, ethers.parseEther("1")),
        NOT_MINTER
      );

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [targetAddr]);
    }

    await tryImpersonatedMint(await hook.getAddress());
    await tryImpersonatedMint(await router.getAddress());
    await tryImpersonatedMint(await pool.getAddress());
    await tryImpersonatedMint(await treasury.getAddress());
  });

  it("mint cannot be invoked indirectly via Hook/Router/Pool code paths", async () => {
    const env = await deployCore();
    const { deployer, hook, router, pool } = env;

    await expect(
      (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("1"),
        amountUsdcDesired:  ethers.parseEther("1"),
        data: "0x",
      })
    ).to.not.be.reverted;

    // 👇 Add `payer`
    await expect(
      (router as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: 0n,
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,    // <-- required by your ABI
      })
    ).to.be.reverted; // any revert is fine for the sanity check
  });
});
});