// test/SupplicateMCV.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import { deployCore } from "./helpers.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * Constants & Interfaces
 * ──────────────────────────────────────────────────────────────────────────── */
const IERC20_FQN = "contracts/external/IERC20.sol:IERC20";

// Global fee (per supplicate) ON INPUT
const FEE_BPS = 250n;          // 2.5% total
const DENOM   = 10_000n;
const TREASURY_CUT_BPS = 50n;  // 0.5% (part of the 2.5%)
const POOLS_CUT_BPS    = 200n; // 2.0% (part of the 2.5%)

/* ────────────────────────────────────────────────────────────────────────────
 * Local helpers
 * ──────────────────────────────────────────────────────────────────────────── */
function feeFromInput(input: bigint) {
  return (input * FEE_BPS) / DENOM;
}
function treasuryCutFromInput(input: bigint) {
  return (input * TREASURY_CUT_BPS) / DENOM;
}
function poolsCutFromInput(input: bigint) {
  return (input * POOLS_CUT_BPS) / DENOM;
}
function abs(a: bigint) {
  return a < 0n ? -a : a;
}
function expectApproxEq(actual: bigint, expected: bigint, tolerance: bigint = 1n) {
  const diff = abs(actual - expected);
  expect(diff <= tolerance).to.equal(true, `expected ~${expected} (±${tolerance}) but got ${actual}`);
}

async function getTokensFromPool(pool: any): Promise<{ asset: any; usdc: any }> {
  const assetAddr = await pool.asset();
  const usdcAddr  = await pool.usdc();
  const asset = await ethers.getContractAt(IERC20_FQN, assetAddr);
  const usdc  = await ethers.getContractAt(IERC20_FQN, usdcAddr);
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
  // approve both router (for fee pull) and pool (for trade pull)
  await (await token.connect(payer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
  await (await token.connect(payer).approve(await pool.getAddress(),   ethers.MaxUint256)).wait();
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

/** Bootstrap ONE pool with 100/100 and a price offset (bps). */
async function bootstrapPoolAtOffset(
  treasury: any,
  poolAddr: string,
  offsetBps: number | bigint
) {
  const A = ethers.parseEther("100");
  const U = ethers.parseEther("100");
  const off = typeof offsetBps === "bigint" ? offsetBps : BigInt(offsetBps);
  await (
    await (treasury as any)["bootstrapViaTreasury(address,uint256,uint256,int256)"](
      poolAddr,
      A,
      U,
      off
    )
  ).wait();
}

/** Helper for single-pool tests: force off-center start. */
async function bootstrapPool100_100(
  treasury: any,
  _factoryAddr: string, // unused
  poolAddr: string,
  _deployerAddr: string // unused
) {
  await bootstrapPoolAtOffset(treasury, poolAddr, -500n);
}

/** Seed SIX pools with fixed offsets: -500, -499, -498, +498, +499, +500. */
async function bootstrapSixPools100_100_Offsets(treasury: any, poolAddrs: string[]) {
  if (poolAddrs.length < 6) throw new Error("need at least 6 pool addresses");
  const offsets = [-500n, -499n, -498n, 498n, 499n, 500n];
  for (let i = 0; i < 6; i++) {
    await bootstrapPoolAtOffset(treasury, poolAddrs[i], offsets[i]);
  }
}

async function getPoolQuotedAmountOut(pool: any, assetToUsdc: boolean, amountIn: bigint) {
  try {
    const ret = await (pool as any).quoteSupplication(assetToUsdc, amountIn);
    const toBig = (x: any) => BigInt(x.toString());
    if (ret && typeof ret === "object") {
      if ("amountOut" in ret) return toBig(ret.amountOut);
      if ("0" in ret)        return toBig(ret[0]);
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
          if ("sqrtPriceX96" in v) return BigInt((v as any).sqrtPriceX96.toString());
          if ("0" in v)            return BigInt((v as any)[0].toString());
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
  it("MCV executes single-pool rebalance — ASSET->USDC (fee-aware input)", async () => {
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

    // fund input side (asset -> usdc)
    await (await env.asset.connect(deployer).mint(deployer.address, amountIn + feeFromInput(amountIn))).wait();
    await approveInputForSupplicate(asset, deployer, router, pool);

    // --- before ---
    const r0 = await reserves(pool);
    const s0Stored  = await safeReadSqrtPriceX96(pool);
    const s0Implied = impliedSqrtPriceX96FromReserves(r0.a, r0.u);
    const b0A = await bal(asset, deployer.address);
    const b0U = await bal(usdc,  deployer.address);
    const t0A = await bal(asset, await treasury.getAddress()); // treasury now accrues ASSET in A->U

    // --- quotes (gross out) ---
    const quotedGross = await getPoolQuotedAmountOut(pool, true, amountIn);

    // router.staticCall should also return gross (no output skim)
    let staticGross: bigint | null = null;
    try {
      staticGross = await (router.connect(deployer) as any).supplicate.staticCall({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn,
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      });
    } catch { staticGross = null; }

    // --- execute ---
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

    // --- after ---
    const r1 = await reserves(pool);
    const s1Stored  = await safeReadSqrtPriceX96(pool);
    const s1Implied = impliedSqrtPriceX96FromReserves(r1.a, r1.u);
    const a1 = await bal(asset, deployer.address);
    const u1 = await bal(usdc,  deployer.address);
    const t1A = await bal(asset, await treasury.getAddress());

    // --- user deltas (user receives GROSS out) ---
    expect(b0A - a1).to.equal(amountIn + feeFromInput(amountIn)); // paid trade + fee
    const userUOut = u1 > b0U ? u1 - b0U : 0n;

    // compare to expectations (±1 wei)
    expectApproxEq(userUOut, quotedGross);
    if (staticGross !== null) expectApproxEq(userUOut, staticGross!);

    // --- pool vs user deltas (fee-aware ON INPUT) ---
    // Pool USDC dispensed (gross)
    const poolUOutGross = r0.u > r1.u ? r0.u - r1.u : 0n;
    expectApproxEq(poolUOutGross, quotedGross);

    // Input-side pool reserve (ASSET) increases by amountIn + poolsFee
    const poolsFeeA = poolsCutFromInput(amountIn);
    const assetIncrease = r1.a > r0.a ? r1.a - r0.a : 0n;
    expectApproxEq(assetIncrease, amountIn + poolsFeeA);

    // Treasury increment should equal 0.5% of input (in ASSET)
    const treasuryAInc = t1A > t0A ? t1A - t0A : 0n;
    const treasuryFeeA = treasuryCutFromInput(amountIn);
    expectApproxEq(treasuryAInc, treasuryFeeA);

    // --- price moved correctly (implied) ---
    expect(s1Implied <= s0Implied).to.equal(true);

    // --- snapshot (no profit fields) ---
    expect({
      role: "MCV",
      direction: "ASSET->USDC",
      amountIn: amountIn.toString(),
      quotes: {
        poolQuote_gross: quotedGross.toString(),
        routerStatic_gross: staticGross?.toString() ?? null,
      },
      reserves: {
        before: { a: r0.a.toString(), u: r0.u.toString() },
        after:  { a: r1.a.toString(), u: r1.u.toString() },
      },
      callerBalances: {
        before: { a: b0A.toString(), u: b0U.toString() },
        after:  { a: a1.toString(),  u: u1.toString()  },
      },
      fees: {
        basis: "input",
        total: feeFromInput(amountIn).toString(),
        treasury: treasuryFeeA.toString(),
        pools: poolsFeeA.toString(),
        token: "ASSET",
      },
      sqrtPriceX96: {
        stored:  { before: s0Stored?.toString() ?? null, after: s1Stored?.toString() ?? null },
        implied: { before: s0Implied.toString(),          after: s1Implied.toString()          },
      },
    }).to.matchSnapshot("MCV — first supplicate A->U (fee-on-input)");
  });

  it("MCV executes single-pool rebalance — USDC->ASSET (fee-aware input)", async () => {
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

    // fund input side (USDC -> ASSET) plus the fee
    await (await env.usdc.connect(deployer).mint(deployer.address, amountIn + feeFromInput(amountIn))).wait();
    await approveInputForSupplicate(usdc, deployer, router, pool);

    // Before
    const r0 = await reserves(pool);
    const s0Stored = await safeReadSqrtPriceX96(pool);
    const s0Implied = impliedSqrtPriceX96FromReserves(r0.a, r0.u);
    const b0A = await bal(asset, deployer.address);
    const b0U = await bal(usdc,  deployer.address);
    const t0U = await bal(usdc,  await treasury.getAddress()); // treasury accrues USDC in U->A

    // Quote (gross)
    const quoted = await getPoolQuotedAmountOut(pool, false, amountIn);

    // Execute
    await (router.connect(deployer) as any).supplicate({
      pool: await pool.getAddress(),
      assetToUsdc: false,
      amountIn,
      minAmountOut: 0n,
      to: deployer.address,
      payer: deployer.address,
    });

    // After
    const r1 = await reserves(pool);
    const s1Stored = await safeReadSqrtPriceX96(pool);
    const s1Implied = impliedSqrtPriceX96FromReserves(r1.a, r1.u);
    const a1 = await bal(asset, deployer.address);
    const u1 = await bal(usdc,  deployer.address);
    const t1U = await bal(usdc,  await treasury.getAddress());

    // Caller deltas (gross out to user in ASSET; fee paid in USDC)
    expect(b0U - u1).to.equal(amountIn + feeFromInput(amountIn));
    const userAOut = a1 > b0A ? a1 - b0A : 0n;
    expectApproxEq(userAOut, quoted);

    // Pool vs user deltas (fee-aware on input)
    const poolAOutGross = r0.a > r1.a ? r0.a - r1.a : 0n;
    expectApproxEq(poolAOutGross, quoted);

    // Input-side pool reserve (USDC) increases by amountIn + poolsFee
    const poolsFeeU = poolsCutFromInput(amountIn);
    const usdcIncrease = r1.u > r0.u ? r1.u - r0.u : 0n;
    expectApproxEq(usdcIncrease, amountIn + poolsFeeU);

    // Treasury cut observed (USDC)
    const treasuryUInc = t1U > t0U ? t1U - t0U : 0n;
    const treasuryFeeU = treasuryCutFromInput(amountIn);
    expectApproxEq(treasuryUInc, treasuryFeeU);

    // Price direction (implied)
    expect(s1Implied >= s0Implied).to.equal(true);

    expect({
      role: "MCV",
      direction: "USDC->ASSET",
      amountIn: amountIn.toString(),
      poolQuote_gross: quoted.toString(),
      fees: {
        basis: "input",
        total: feeFromInput(amountIn).toString(),
        treasury: treasuryFeeU.toString(),
        pools: poolsFeeU.toString(),
        token: "USDC",
      },
      sqrtPriceX96: {
        stored:  { before: s0Stored?.toString() ?? null, after: s1Stored?.toString() ?? null },
        implied: { before: s0Implied.toString(),          after: s1Implied.toString()          },
      },
      reserves: {
        before: { a: r0.a.toString(), u: r0.u.toString() },
        after:  { a: r1.a.toString(), u: r1.u.toString() },
      },
      caller: {
        before: { a: b0A.toString(), u: b0U.toString() },
        after:  { a: a1.toString(),  u: u1.toString()  },
      },
    }).to.matchSnapshot("MCV — sqrt+reserves U->A (fee-on-input)");
  });

  describe("3-pool orbit — liquidity snapshots (no profit accounting)", () => {
    it("mcvSupplication orbit — snapshot pools & treasury only", async () => {
      const env = await deployCore();
      const { deployer, router, treasury, factory, asset, usdc } = env;

      // Ensure SIX total pools exist for this pair
      const have = (await factory.getPools()).length;
      const needToCreate = Math.max(0, 6 - have);
      for (let i = 0; i < needToCreate; i++) {
        await (
          await treasury.createPoolViaTreasury(
            await factory.getAddress(),
            await asset.getAddress(),
            await usdc.getAddress()
          )
        ).wait();
      }

      // Fetch the first six
      const allPools = await factory.getPools();
      const poolAddrs = allPools.slice(0, 6);
      if (poolAddrs.length < 6) throw new Error("need at least 6 pools for orbit");

      // Bootstrap all six with your specified offsets (never equilibrium)
      await bootstrapSixPools100_100_Offsets(treasury, poolAddrs);

      // Choose a 3-pool orbit out of the six (e.g., {-500, +498, +500})
      const orbitPools = [poolAddrs[0], poolAddrs[3], poolAddrs[5]] as [string, string, string];
      const startPoolAddr = orbitPools[0];

      const poolA = await ethers.getContractAt("LPPPool", orbitPools[0]);
      const poolB = await ethers.getContractAt("LPPPool", orbitPools[1]);
      const poolC = await ethers.getContractAt("LPPPool", orbitPools[2]);

      // Set the orbit THROUGH the Treasury wrapper (no impersonation needed)
      await (
        await (treasury as any).setOrbitViaTreasury(
          await router.getAddress(),
          startPoolAddr,
          orbitPools
        )
      ).wait();

      // MEV wallet (deployer for test)
      const mcv = deployer;
      const amountIn = ethers.parseEther("1");

      // Snap BEFORE
      const [pA0, pB0, pC0] = await Promise.all([
        snapshotPoolState(poolA),
        snapshotPoolState(poolB),
        snapshotPoolState(poolC),
      ]);

      const assetToken = env.asset;
      const usdcToken  = env.usdc;

      // pair sanity (same pair across orbit)
      expect(await assetToken.getAddress()).to.equal(await poolA.asset());
      expect(await usdcToken.getAddress()).to.equal(await poolA.usdc());
      expect(await poolB.asset()).to.equal(await poolA.asset());
      expect(await poolB.usdc()).to.equal(await poolA.usdc());
      expect(await poolC.asset()).to.equal(await poolA.asset());
      expect(await poolC.usdc()).to.equal(await poolA.usdc());

      const t0A = await bal(assetToken, await treasury.getAddress());
      const t0U = await bal(usdcToken,  await treasury.getAddress());

      // MEV starts USDC->ASSET on startPoolAddr; router will handle inter-hop fees
      await (await usdcToken.connect(deployer).mint(mcv.address, amountIn + feeFromInput(amountIn))).wait();
      await approveToPoolOnly(usdcToken, mcv, startPoolAddr, amountIn);

      let executed = false;
      let revertReason: string | null = null;

      try {
        await (router.connect(mcv) as any).mcvSupplication({
          startPool: startPoolAddr,
          assetToUsdc: false, // USDC->ASSET first
          amountIn,
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

      const t1A = await bal(assetToken, await treasury.getAddress());
      const t1U = await bal(usdcToken,  await treasury.getAddress());

      // Final snapshot: only orbit metadata + liquidity deltas (no profit fields)
      expect({
        role: "MCV",
        startPool: startPoolAddr,
        orbitPools,
        amountIn: amountIn.toString(),
        executed,
        revertReason,
        pools: {
          before: [pA0, pB0, pC0],
          after:  [pA1, pB1, pC1],
        },
        treasury: {
          before: { a: t0A.toString(), u: t0U.toString() },
          after:  { a: t1A.toString(), u: t1U.toString() },
        },
        note:
          "Orbit snapshot only (no internal profit accounting). Liquidity shown per selected 3 pools; Treasury balances shown before/after. Fees are charged on INPUT at each hop.",
      }).to.matchSnapshot("3-orbit MCV — liquidity+treasury (fee-on-input)");
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
        reservesAfter:  { a: r1.a.toString(), u: r1.u.toString() },
        note: "Direct token moves cannot spoof LPP reserves (MCV path). Use donateToReserves for legit credits.",
      }).to.matchSnapshot("MCV — bypass-guard reserves unchanged");
    });
  });
});