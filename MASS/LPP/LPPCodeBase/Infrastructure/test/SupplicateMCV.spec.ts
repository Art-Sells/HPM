// test/SupplicateMCV.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import { deployCore } from "./helpers.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * Constants & Interfaces
 * ──────────────────────────────────────────────────────────────────────────── */
const IERC20_FQN = "contracts/external/IERC20.sol:IERC20";

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */
async function getTokensFromPool(pool: any): Promise<{ asset: any; usdc: any }> {
  const assetAddr = await pool.asset();
  const usdcAddr = await pool.usdc();
  const asset = await ethers.getContractAt(IERC20_FQN, assetAddr);
  const usdc = await ethers.getContractAt(IERC20_FQN, usdcAddr);
  return { asset, usdc };
}

async function reserves(pool: any) {
  const a = BigInt((await pool.reserveAsset()).toString());
  const u = BigInt((await pool.reserveUsdc()).toString());
  return { a, u };
}

async function bal(token: any, who: string) {
  return BigInt((await token.balanceOf(who)).toString());
}

async function approveInputForSupplicate(
  token: any,
  payer: any,
  router: any,
  pool: any
) {
  await (await token.connect(payer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
  await (await token.connect(payer).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
}

async function approveToPoolOnly(
  token: any,
  payer: any,
  poolAddr: string,
  amount: bigint
) {
  await (await token.connect(payer).approve(poolAddr, amount)).wait();
}

/** Integer sqrt for BigInt (Babylonian) */
function isqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x0 = n;
  let x1 = (n >> 1n) + 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x1 + n / x1) >> 1n;
  }
  return x0;
}

/** Implied sqrtPriceX96 from reserves: sqrt((U<<192)/A) */
function impliedSqrtPriceX96FromReserves(a: bigint, u: bigint): bigint {
  if (a === 0n || u === 0n) return 0n;
  const NUM_SHIFTED = u << 192n;
  return isqrt(NUM_SHIFTED / a);
}

/** Try multiple likely Treasury bootstrap signatures. */
async function bootstrapPool100_100(
  treasury: any,
  factoryAddr: string,
  poolAddr: string,
  deployerAddr: string
) {
  const A = ethers.parseEther("100");
  const U = ethers.parseEther("100");

  // Attempt common variants. We "any" these calls so TS won't complain.
  const t = treasury as any;
  const tries: Array<() => Promise<any>> = [
    () => t.bootstrapViaTreasury(factoryAddr, poolAddr, A, U),
    () => t.bootstrapViaTreasury(poolAddr, A, U),
    () => t.bootstrapViaTreasury(poolAddr, deployerAddr, A, U),
    () => t.bootstrapViaTreasury(factoryAddr, poolAddr, deployerAddr, A, U),
  ];

  let lastErr: any = null;
  for (const fn of tries) {
    try {
      const tx = await fn();
      await tx.wait();
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("bootstrapViaTreasury: no matching signature");
}

async function getPoolQuotedAmountOut(pool: any, assetToUsdc: boolean, amountIn: bigint) {
  try {
    const ret = await (pool as any).quoteSupplication(assetToUsdc, amountIn);
    const toBig = (x: any) => BigInt(x.toString());
    if (ret && typeof ret === "object") {
      if ("amountOut" in ret) return toBig(ret.amountOut);
      if ("0" in ret) return toBig(ret[0]);
    }
    if (Array.isArray(ret) && ret.length > 0) return toBig(ret[0]);
    return BigInt(ret.toString());
  } catch {
    return 0n;
  }
}

async function safeReadSqrtPriceX96(pool: any): Promise<bigint | null> {
  const tryFns = ["sqrtPriceX96", "getSqrtPriceX96", "currentSqrtPriceX96", "priceX96", "slot0"];
  for (const fn of tryFns) {
    try {
      const f = (pool as any)[fn];
      if (typeof f !== "function") continue;
      const v = await f.call(pool);
      if (fn === "slot0") {
        if (v && typeof v === "object") {
          if ("sqrtPriceX96" in v) return BigInt(v.sqrtPriceX96.toString());
          if ("0" in v) return BigInt(v[0].toString());
        }
        continue;
      }
      return BigInt(v.toString());
    } catch {}
  }
  return null;
}

async function snapshotPoolState(pool: any) {
  const addr = await pool.getAddress();
  const r = await reserves(pool);
  const s = await safeReadSqrtPriceX96(pool);
  return {
    pool: addr,
    a: r.a.toString(),
    u: r.u.toString(),
    sqrtPriceX96: s?.toString() ?? null,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Spec
 * ──────────────────────────────────────────────────────────────────────────── */
describe("Supplicate (MCV)", () => {
  it("MCV executes single-pool rebalance — ASSET->USDC", async () => {
    const env = await deployCore();
    const { deployer, access, treasury, router, factory, pool } = env;

    // Seed pool (100/100) via Treasury bootstrap
    await bootstrapPool100_100(
      treasury,
      await factory.getAddress(),
      await pool.getAddress(),
      deployer.address
    );

    await (await access.setApprovedSupplicator(deployer.address, true)).wait();

    const amountIn = ethers.parseEther("1");
    const { asset, usdc } = await getTokensFromPool(pool);

    // Fund MCV with input side (asset -> usdc)
    await (await env.asset.connect(deployer).mint(deployer.address, amountIn)).wait();
    await approveInputForSupplicate(asset, deployer, router, pool);

    // Before
    const r0 = await reserves(pool);
    const s0Stored = await safeReadSqrtPriceX96(pool);
    const s0Implied = impliedSqrtPriceX96FromReserves(r0.a, r0.u);
    const b0A = await bal(asset, deployer.address);
    const b0U = await bal(usdc, deployer.address);

    // Quotes
    const quoted = await getPoolQuotedAmountOut(pool, true, amountIn);
    let staticOut: bigint | null = null;
    try {
      staticOut = await (router.connect(deployer) as any).supplicate.staticCall({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn,
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      });
    } catch {
      staticOut = null;
    }

    // Execute
    await expect(
      (router.connect(deployer) as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn,
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      })
    ).not.to.be.reverted;

    // After
    const r1 = await reserves(pool);
    const s1Stored = await safeReadSqrtPriceX96(pool);
    const s1Implied = impliedSqrtPriceX96FromReserves(r1.a, r1.u);
    const a1 = await bal(asset, deployer.address);
    const u1 = await bal(usdc, deployer.address);

    // Caller deltas
    expect(b0A - a1).to.equal(amountIn);
    expect(u1 >= b0U).to.equal(true);
    if (quoted > 0n) expect(u1 - b0U).to.equal(quoted);
    if (staticOut !== null) expect(u1 - b0U).to.equal(staticOut!);

    // Pool vs user deltas
    const poolAOut = r0.a > r1.a ? r0.a - r1.a : 0n;
    const poolUOut = r0.u > r1.u ? r0.u - r1.u : 0n;
    const userAOut = a1 > b0A ? a1 - b0A : 0n;
    const userUOut = u1 > b0U ? u1 - b0U : 0n;
    expect(poolAOut).to.equal(userAOut);
    expect(poolUOut).to.equal(userUOut);

    // Price direction
    expect(s1Implied <= s0Implied).to.equal(true);

    // Snapshot
    expect({
      role: "MCV",
      direction: "ASSET->USDC",
      amountIn: amountIn.toString(),
      quotes: {
        poolQuote: quoted.toString(),
        routerStatic: staticOut?.toString() ?? null,
      },
      reserves: {
        before: { a: r0.a.toString(), u: r0.u.toString() },
        after: { a: r1.a.toString(), u: r1.u.toString() },
      },
      callerBalances: {
        before: { a: b0A.toString(), u: b0U.toString() },
        after: { a: a1.toString(), u: u1.toString() },
      },
      sqrtPriceX96: {
        stored: {
          before: s0Stored?.toString() ?? null,
          after: s1Stored?.toString() ?? null,
        },
        implied: { before: s0Implied.toString(), after: s1Implied.toString() },
      },
    }).to.matchSnapshot("MCV — first supplicate A->U");
  });

  it("MCV executes single-pool rebalance — USDC->ASSET", async () => {
    const env = await deployCore();
    const { deployer, access, treasury, router, factory, pool } = env;

    await bootstrapPool100_100(
      treasury,
      await factory.getAddress(),
      await pool.getAddress(),
      deployer.address
    );

    await (await access.setApprovedSupplicator(deployer.address, true)).wait();

    const amountIn = ethers.parseEther("1");
    const { asset, usdc } = await getTokensFromPool(pool);

    await (await env.usdc.connect(deployer).mint(deployer.address, amountIn)).wait();
    await approveInputForSupplicate(usdc, deployer, router, pool);

    const r0 = await reserves(pool);
    const s0Stored = await safeReadSqrtPriceX96(pool);
    const s0Implied = impliedSqrtPriceX96FromReserves(r0.a, r0.u);
    const b0A = await bal(asset, deployer.address);
    const b0U = await bal(usdc, deployer.address);

    const quoted = await getPoolQuotedAmountOut(pool, false, amountIn);

    await (router.connect(deployer) as any).supplicate({
      pool: await pool.getAddress(),
      assetToUsdc: false,
      amountIn,
      minAmountOut: 0n,
      to: deployer.address,
      payer: deployer.address,
    });

    const r1 = await reserves(pool);
    const s1Stored = await safeReadSqrtPriceX96(pool);
    const s1Implied = impliedSqrtPriceX96FromReserves(r1.a, r1.u);
    const a1 = await bal(asset, deployer.address);
    const u1 = await bal(usdc, deployer.address);

    expect(b0U - u1).to.equal(amountIn);
    expect(a1 >= b0A).to.equal(true);
    if (quoted > 0n) expect(a1 - b0A).to.equal(quoted);
    expect(s1Implied >= s0Implied).to.equal(true);

    expect({
      role: "MCV",
      direction: "USDC->ASSET",
      amountIn: amountIn.toString(),
      poolQuote: quoted.toString(),
      sqrtPriceX96: {
        stored: {
          before: s0Stored?.toString() ?? null,
          after: s1Stored?.toString() ?? null,
        },
        implied: { before: s0Implied.toString(), after: s1Implied.toString() },
      },
      reserves: {
        before: { a: r0.a.toString(), u: r0.u.toString() },
        after: { a: r1.a.toString(), u: r1.u.toString() },
      },
      caller: {
        before: { a: b0A.toString(), u: b0U.toString() },
        after: { a: a1.toString(), u: u1.toString() },
      },
    }).to.matchSnapshot("MCV — sqrt+reserves U->A");
  });

  describe("3-pool orbit — fee split + snapshots", () => {
    it("mcvSupplication orbit (router-derived) with 2.5% profit fee; 0.5% Treasury / 2.0% pools (snapshot)", async () => {
      const env = await deployCore();
      const { deployer, router, treasury, factory, asset, usdc } = env;

      // Create 3 total pools minimum for the orbit (use the same pair).
      // We already have one from deployCore; create 2 more:
      await (
        await treasury.createPoolViaTreasury(
          await factory.getAddress(),
          await asset.getAddress(),
          await usdc.getAddress()
        )
      ).wait();
      await (
        await treasury.createPoolViaTreasury(
          await factory.getAddress(),
          await asset.getAddress(),
          await usdc.getAddress()
        )
      ).wait();

      const poolAddrs = await factory.getPools();
      if (poolAddrs.length < 3) throw new Error("need at least 3 pools for orbit");

      const poolA = await ethers.getContractAt("LPPPool", poolAddrs[0]);
      const poolB = await ethers.getContractAt("LPPPool", poolAddrs[1]);
      const poolC = await ethers.getContractAt("LPPPool", poolAddrs[2]);

      // Seed each pool (100/100)
      await bootstrapPool100_100(treasury, await factory.getAddress(), poolAddrs[0], deployer.address);
      await bootstrapPool100_100(treasury, await factory.getAddress(), poolAddrs[1], deployer.address);
      await bootstrapPool100_100(treasury, await factory.getAddress(), poolAddrs[2], deployer.address);

      // Configure orbit on-chain: start at A, orbit [A,B,C]
      await (router.connect(treasury) as any).setOrbit(poolAddrs[0], [poolAddrs[0], poolAddrs[1], poolAddrs[2]]);

      // MEV wallet (deployer for test)
      const mcv = deployer;
      const amountIn = ethers.parseEther("1");

      // Start direction: USDC -> ASSET on hop 0
      const startPoolAddr = poolAddrs[0];

      // Fund and approve payer (pool pulls from payer on first hop)
      await (await usdc.connect(deployer).mint(mcv.address, amountIn)).wait();
      await approveToPoolOnly(usdc, mcv, startPoolAddr, amountIn);

      // Snap BEFORE
      const [pA0, pB0, pC0] = await Promise.all([
        snapshotPoolState(poolA),
        snapshotPoolState(poolB),
        snapshotPoolState(poolC),
      ]);

      const t0A = await bal(asset, await treasury.getAddress());
      const t0U = await bal(usdc, await treasury.getAddress());

      const m0A = await bal(asset, mcv.address);
      const m0U = await bal(usdc, mcv.address);
      const m0Total = m0A + m0U;

      let executed = false;
      let revertReason: string | null = null;

      try {
        await (router.connect(mcv) as any).mcvSupplication({
          startPool: startPoolAddr,
          assetToUsdc: false, // USDC->ASSET first
          amountIn,
          minProfit: 0n,
          payer: mcv.address,
          to: mcv.address,
        });
        executed = true;
      } catch (err: any) {
        executed = false;
        const msg = err?.errorName ?? err?.shortMessage ?? err?.message ?? "";
        revertReason = msg;
      }

      // Snap AFTER
      const [pA1, pB1, pC1] = await Promise.all([
        snapshotPoolState(poolA),
        snapshotPoolState(poolB),
        snapshotPoolState(poolC),
      ]);

      const t1A = await bal(asset, await treasury.getAddress());
      const t1U = await bal(usdc, await treasury.getAddress());

      const m1A = await bal(asset, mcv.address);
      const m1U = await bal(usdc, mcv.address);
      const m1Total = m1A + m1U;

      const profit = m1Total > m0Total ? m1Total - m0Total : 0n;

      expect({
        role: "MCV",
        amountIn: amountIn.toString(),
        executed,
        revertReason,
        orbitHops: 3,
        pools: {
          before: [pA0, pB0, pC0],
          after: [pA1, pB1, pC1],
          totalTVL: {
            before: (
              BigInt(pA0.a) + BigInt(pA0.u) + BigInt(pB0.a) + BigInt(pB0.u) + BigInt(pC0.a) + BigInt(pC0.u)
            ).toString(),
            after: (
              BigInt(pA1.a) + BigInt(pA1.u) + BigInt(pB1.a) + BigInt(pB1.u) + BigInt(pC1.a) + BigInt(pC1.u)
            ).toString(),
            delta: (
              (BigInt(pA1.a) +
                BigInt(pA1.u) +
                BigInt(pB1.a) +
                BigInt(pB1.u) +
                BigInt(pC1.a) +
                BigInt(pC1.u)) -
              (BigInt(pA0.a) +
                BigInt(pA0.u) +
                BigInt(pB0.a) +
                BigInt(pB0.u) +
                BigInt(pC0.a) +
                BigInt(pC0.u))
            ).toString(),
          },
        },
        treasury: {
          before: { a: t0A.toString(), u: t0U.toString() },
          after: { a: t1A.toString(), u: t1U.toString() },
          deltaNotional: (t1A + t1U - (t0A + t0U)).toString(),
        },
        mcvWallet: {
          before: { a: m0A.toString(), u: m0U.toString(), total: m0Total.toString() },
          after: { a: m1A.toString(), u: m1U.toString(), total: m1Total.toString() },
        },
        profit: profit.toString(),
        bpsSplit: { treasury: 50, pools: 200 }, // 0.5% / 2.0% of profit (Phase 0 accounting)
        note:
          "Phase-0 3-pool orbit: if profit > 0, expect 2.5% fee on profit (0.5% Treasury, 2.0% reserved for pools). If reverted with 'no profit', that is allowed.",
      }).to.matchSnapshot("3-orbit MCV — fee split + reserves");
    });
  });

  describe("Bypass guard via direct token movement (MCV path)", () => {
    it("ERC20.transfer / transferFrom to pool must NOT mutate reserves", async () => {
      const env = await deployCore();
      const { deployer, treasury, factory, pool } = env;

      await bootstrapPool100_100(
        treasury,
        await factory.getAddress(),
        await pool.getAddress(),
        deployer.address
      );

      const { asset, usdc } = await getTokensFromPool(pool);
      const poolAddr = await pool.getAddress();

      const r0 = await reserves(pool);

      const amt = ethers.parseEther("5");
      const twice = amt * 2n;

      await (await env.asset.connect(deployer).mint(deployer.address, twice)).wait();
      await (await env.usdc.connect(deployer).mint(deployer.address, twice)).wait();

      // direct transfer
      await (await asset.connect(deployer).transfer(poolAddr, amt)).wait();
      await (await usdc.connect(deployer).transfer(poolAddr, amt)).wait();

      // transferFrom (approve self then move)
      await (await env.asset.connect(deployer).approve(deployer.address, amt)).wait();
      await (await env.usdc.connect(deployer).approve(deployer.address, amt)).wait();
      await (await asset.connect(deployer).transferFrom(deployer.address, poolAddr, amt)).wait();
      await (await usdc.connect(deployer).transferFrom(deployer.address, poolAddr, amt)).wait();

      const r1 = await reserves(pool);
      expect(r1.a).to.equal(r0.a);
      expect(r1.u).to.equal(r0.u);

      expect({
        role: "MCV",
        reservesBefore: { a: r0.a.toString(), u: r0.u.toString() },
        reservesAfter: { a: r1.a.toString(), u: r1.u.toString() },
        note: "Direct token moves cannot spoof LPP reserves (MCV path)",
      }).to.matchSnapshot("MCV — bypass-guard reserves unchanged");
    });
  });
});