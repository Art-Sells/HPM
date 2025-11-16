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

/** CFMM gross out with an extra amount credited to the input reserve *before* the trade */
function grossOutWithPreAddedInput(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  extraInputBeforeSwap: bigint
): bigint {
  return (amountIn * reserveOut) / (reserveIn + extraInputBeforeSwap + amountIn);
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

    // fund input side (asset -> usdc), including the input-side fee
    await (await env.asset.connect(deployer).mint(deployer.address, amountIn + feeFromInput(amountIn))).wait();
    await approveInputForSupplicate(asset, deployer, router, pool);

    // --- before ---
    const r0 = await reserves(pool);
    const s0Stored  = await safeReadSqrtPriceX96(pool);
    const s0Implied = impliedSqrtPriceX96FromReserves(r0.a, r0.u);
    const b0A = await bal(asset, deployer.address);
    const b0U = await bal(usdc,  deployer.address);
    const t0A = await bal(asset, await treasury.getAddress()); // treasury accrues ASSET in A->U

    // Pre-fee quote (for reference only; not used for equality check)
    const quotedPreFeeGross = await getPoolQuotedAmountOut(pool, true, amountIn);

    // Router.staticCall should reflect the *post-donation* reserves path (gross out)
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

    // Expected gross with input fee donation to input reserve (pools 2.0%)
    const expectedGross = grossOutWithPreAddedInput(
      amountIn,
      r0.a,            // input reserve = ASSET
      r0.u,            // output reserve = USDC
      poolsCutFromInput(amountIn) // extra ASSET donated before swap
    );

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

    // --- user deltas (user receives GROSS out; fee paid in ASSET)
    expect(b0A - a1).to.equal(amountIn + feeFromInput(amountIn));
    const userUOut = u1 > b0U ? u1 - b0U : 0n;

    // compare to expected path (±1 wei)
    expectApproxEq(userUOut, expectedGross);
    if (staticGross !== null) expectApproxEq(userUOut, staticGross!);

    // --- pool vs user deltas (fee-aware ON INPUT)
    const poolUOutGross = r0.u > r1.u ? r0.u - r1.u : 0n;
    expectApproxEq(poolUOutGross, expectedGross);

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
        poolQuote_preFeeGross: quotedPreFeeGross.toString(),
        routerStatic_gross: staticGross?.toString() ?? null,
        expectedGross_afterDonation: expectedGross.toString(),
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
    }).to.matchSnapshot("MCV — first supplicate A->U (fee-on-input, donated-before-swap)");
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

    // Pre-fee quote (for reference only)
    const quotedPreFeeGross = await getPoolQuotedAmountOut(pool, false, amountIn);

    // Expected gross with donation of pools 2.0% to USDC reserve before swap
    const expectedGross = grossOutWithPreAddedInput(
      amountIn,
      r0.u,            // input reserve = USDC
      r0.a,            // output reserve = ASSET
      poolsCutFromInput(amountIn) // extra USDC donated before swap
    );

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

    // Caller deltas (gross out in ASSET; fee paid in USDC)
    expect(b0U - u1).to.equal(amountIn + feeFromInput(amountIn));
    const userAOut = a1 > b0A ? a1 - b0A : 0n;
    expectApproxEq(userAOut, expectedGross);

    // Pool vs user deltas (fee-aware on input)
    const poolAOutGross = r0.a > r1.a ? r0.a - r1.a : 0n;
    expectApproxEq(poolAOutGross, expectedGross);

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
      poolQuote_preFeeGross: quotedPreFeeGross.toString(),
      expectedGross_afterDonation: expectedGross.toString(),
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
    }).to.matchSnapshot("MCV — sqrt+reserves U->A (fee-on-input, donated-before-swap)");
  });

  describe("3-pool orbit — liquidity snapshots (with deltas + hop proof)", () => {
    it("mcvSupplication orbit — snapshot pools & treasury, deltas, offsets, hop order", async () => {
      const env = await deployCore();
      const { deployer, router, treasury, factory, asset, usdc } = env;

      // Ensure SIX pools exist for this pair (we'll use first 3 as the orbit)
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

      // Grab pools and bootstrap offsets: [-500,-499,-498,+498,+499,+500]
      const allPools = await factory.getPools();
      await (async () => {
        const offsets = [-500n, -499n, -498n, 498n, 499n, 500n];
        for (let i = 0; i < 6; i++) {
          await (
            await (treasury as any)["bootstrapViaTreasury(address,uint256,uint256,int256)"](
              allPools[i], ethers.parseEther("100"), ethers.parseEther("100"), offsets[i]
            )
          ).wait();
        }
      })();


      // Orbit = first 3 (shared sign, e.g., NEG) — force a brand-new mutable array
      const orbitPools = [ allPools[0], allPools[1], allPools[2] ] as [string, string, string];
      const startPoolAddr = orbitPools[0];

      await (
        await (treasury as any).setOrbitViaTreasury(
          await router.getAddress(),
          startPoolAddr,
          // pass a fresh array literal (also mutable)
          [ orbitPools[0], orbitPools[1], orbitPools[2] ]
        )
      ).wait();

      // Contracts for snapshots
      const poolA = await ethers.getContractAt("LPPPool", orbitPools[0]);
      const poolB = await ethers.getContractAt("LPPPool", orbitPools[1]);
      const poolC = await ethers.getContractAt("LPPPool", orbitPools[2]);

      // ----- INLINE FUNDING + APPROVALS (USDC-in across ALL 3 hops) -----
      const amountIn = ethers.parseEther("1");              // per-hop input
      const feePerHop = (amountIn * 250n) / 10_000n;        // 2.5%
      const totalFee  = feePerHop * 3n;
      const totalIn   = amountIn * 3n;

      await (await env.usdc.connect(deployer).mint(deployer.address, totalIn + totalFee)).wait();
      // router pulls the fees each hop
      await (await env.usdc.connect(deployer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
      // each pool pulls amountIn once
      for (const addr of orbitPools) {
        await (await env.usdc.connect(deployer).approve(addr, amountIn)).wait();
      }

      // BEFORE snapshots
      const snap = async (p: any) => {
        const addr = await p.getAddress();
        const a = BigInt((await p.reserveAsset()).toString());
        const u = BigInt((await p.reserveUsdc()).toString());
        const s = (() => p.sqrtPriceX96 || p.getSqrtPriceX96 || p.priceX96 || p.slot0)();
        let sqrt: bigint | null = null;
        try {
          const v = await s.call(p);
          if (v && typeof v === "object") {
            if ("sqrtPriceX96" in v) sqrt = BigInt(v.sqrtPriceX96.toString());
            else if ("0" in v)       sqrt = BigInt(v[0].toString());
          } else {
            sqrt = BigInt(v.toString());
          }
        } catch {}
        return { pool: addr, a: a.toString(), u: u.toString(), sqrtPriceX96: sqrt?.toString() ?? null };
      };

      const pA0 = await snap(poolA);
      const pB0 = await snap(poolB);
      const pC0 = await snap(poolC);
      const t0A = BigInt((await asset.balanceOf(await treasury.getAddress())).toString());
      const t0U = BigInt((await usdc.balanceOf(await treasury.getAddress())).toString());

      const oA = Number(await poolA.targetOffsetBps());
      const oB = Number(await poolB.targetOffsetBps());
      const oC = Number(await poolC.targetOffsetBps());

      // ----- CALL (object params; legacy mode honors assetToUsdc) -----
      let executed = false;
      let revertReason: string | null = null;
      let receipt: any | null = null;
      try {
        const tx = await (router.connect(deployer) as any).mcvSupplication({
          startPool: startPoolAddr,
          assetToUsdc: false,           // USDC -> ASSET on all 3 hops (legacy honors this)
          amountIn,
          payer: deployer.address,
          to: deployer.address,
        });
        receipt = await tx.wait();
        executed = true;
      } catch (err: any) {
        executed = false;
        revertReason = err?.errorName ?? err?.shortMessage ?? err?.message ?? "";
      }

      // AFTER snapshots
      const pA1 = await snap(poolA);
      const pB1 = await snap(poolB);
      const pC1 = await snap(poolC);
      const t1A = BigInt((await asset.balanceOf(await treasury.getAddress())).toString());
      const t1U = BigInt((await usdc.balanceOf(await treasury.getAddress())).toString());

      // Deltas
      const asBig = (x: any) => BigInt(String(x));
      const poolsWithDelta = [
        { before: pA0, after: pA1, delta: { a: (asBig(pA1.a) - asBig(pA0.a)).toString(), u: (asBig(pA1.u) - asBig(pA0.u)).toString() } },
        { before: pB0, after: pB1, delta: { a: (asBig(pB1.a) - asBig(pB0.a)).toString(), u: (asBig(pB1.u) - asBig(pB0.u)).toString() } },
        { before: pC0, after: pC1, delta: { a: (asBig(pC1.a) - asBig(pC0.a)).toString(), u: (asBig(pC1.u) - asBig(pC0.u)).toString() } },
      ];

      // Prove 3 hops via HopExecuted events
      const HopExecutedSig = ethers.id("HopExecuted(address,bool,address,address,uint256,uint256)");
      const hopTrace = (receipt?.logs ?? [])
        .filter((l: any) => l.topics && l.topics[0] === HopExecutedSig)
        .map((l: any) => {
          const pool = ethers.getAddress("0x" + l.topics[1].slice(26));
          const [assetToUsdc, tokenIn, tokenOut, amtIn, amtOut] =
            ethers.AbiCoder.defaultAbiCoder().decode(
              ["bool","address","address","uint256","uint256"],
              l.data
            );
          return {
            pool,
            assetToUsdc: Boolean(assetToUsdc),
            amountIn: amtIn.toString(),
            amountOut: amtOut.toString(),
            tokenIn,
            tokenOut,
          };
        });

      expect({
        role: "MCV",
        executed,
        revertReason,
        amountIn: amountIn.toString(),
        startPool: startPoolAddr,
        orbitPools,
        offsets: [oA, oB, oC],
        hopTrace,
        pools: {
          before: [pA0, pB0, pC0],
          after:  [pA1, pB1, pC1],
          delta:  poolsWithDelta.map(p => p.delta),
        },
        treasury: {
          before: { a: t0A.toString(), u: t0U.toString() },
          after:  { a: t1A.toString(), u: t1U.toString() },
          delta:  { a: (t1A - t0A).toString(), u: (t1U - t0U).toString() },
        },
        note:
          "Independent 3-hop model: per-hop fee (2.5%) is charged each hop and donated to that hop’s input reserve; treasury receives 0.5% per hop. Params sent as object for ethers v6.",
      }).to.matchSnapshot("3-orbit MCV — liquidity+treasury+delta+hop-proof");
    });
  });

  /* ────────────────────────────────────────────────────────────────────────
   * 3-pool dual-orbit — deltas + automatic flip
   *   - Call 1: use NEG set + USDC-in (3 hops)
   *   - Call 2: flip to POS set + ASSET-in (3 hops)
   *   - Uses per-hop fees; prepares inputs/approvals for all three pools each call
   * ──────────────────────────────────────────────────────────────────────── */
  describe("3-pool dual-orbit — deltas + automatic flip", () => {
    it("uses NEG set first, flips to POS after each mcvSupplication; shows per-pool & treasury deltas", async () => {
      const env = await deployCore();
      const { deployer, router, treasury, factory, asset, usdc } = env;

      // Ensure SIX pools exist
      const have = (await factory.getPools()).length;
      const need = Math.max(0, 6 - have);
      for (let i = 0; i < need; i++) {
        await (
          await treasury.createPoolViaTreasury(
            await factory.getAddress(),
            await asset.getAddress(),
            await usdc.getAddress()
          )
        ).wait();
      }

      // Grab six & bootstrap: first 3 NEG (-500), last 3 POS (+500)
      const all = await factory.getPools();
      const p = all.slice(0, 6);
      for (let i = 0; i < 3; i++) {
        await (await (treasury as any)["bootstrapViaTreasury(address,uint256,uint256,int256)"](
          p[i], ethers.parseEther("100"), ethers.parseEther("100"), -500
        )).wait();
      }
      for (let i = 3; i < 6; i++) {
        await (await (treasury as any)["bootstrapViaTreasury(address,uint256,uint256,int256)"](
          p[i], ethers.parseEther("100"), ethers.parseEther("100"), +500
        )).wait();
      }

      // Wire dual-orbit: start with NEG
      const startPool = p[0];
      await (
        await (treasury as any).setDualOrbitViaTreasury(
          await router.getAddress(),
          startPool,
          [p[0], p[1], p[2]], // NEG
          [p[3], p[4], p[5]], // POS
          /*startWithNeg*/ true
        )
      ).wait();

      const toPool = async (addr: string) => await ethers.getContractAt("LPPPool", addr);
      const poolObjs = await Promise.all(p.map(toPool));

      const snapshot = async () => {
        const arr = await Promise.all(poolObjs.map(async (po) => {
          const addr = await po.getAddress();
          const a = BigInt((await po.reserveAsset()).toString());
          const u = BigInt((await po.reserveUsdc()).toString());
          return { pool: addr, a, u };
        }));
        const treA = BigInt((await asset.balanceOf(await treasury.getAddress())).toString());
        const treU = BigInt((await usdc.balanceOf(await treasury.getAddress())).toString());
        return { pools: arr, treA, treU };
      };

      /* ----------------------- RUN #1 — NEG (USDC-in) ----------------------- */
      const amountIn = ethers.parseEther("1");
      const active0   = await (router as any).getActiveOrbit(startPool);
      const usingNeg0 = active0[1] as boolean;
      const orbit0    = active0[0] as string[];
      expect(usingNeg0).to.equal(true);

      // Fund + approve for ALL 3 NEG pools (per-hop fees)
      {
        const feePerHop = (amountIn * 250n) / 10_000n; // 2.5%
        const totalFee  = feePerHop * 3n;
        const totalIn   = amountIn * 3n;

        await (await env.usdc.connect(deployer).mint(deployer.address, totalIn + totalFee)).wait();
        // router pulls the fee each hop
        await (await env.usdc.connect(deployer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
        // each NEG pool pulls amountIn once
        for (const addr of orbit0) {
          await (await env.usdc.connect(deployer).approve(addr, amountIn)).wait();
        }
      }

      const before1 = await snapshot();

      {
        await (router.connect(deployer) as any).mcvSupplication({
          startPool,
          assetToUsdc: false,   // ignored in dual-orbit; cursor controls direction
          amountIn,
          payer: deployer.address,
          to: deployer.address,
        });
      }

      const after1  = await snapshot();
      const deltas1 = after1.pools.map((aft, i) => {
        const bef = before1.pools[i];
        return { pool: aft.pool, deltaA: (aft.a - bef.a).toString(), deltaU: (aft.u - bef.u).toString() };
      });
      const treDelta1 = { deltaA: (after1.treA - before1.treA).toString(), deltaU: (after1.treU - before1.treU).toString() };

      // Orbit must flip to POS
      const activeAfter1 = await (router as any).getActiveOrbit(startPool);
      expect(activeAfter1[1] as boolean).to.equal(false);

      /* ----------------------- RUN #2 — POS (ASSET-in) ---------------------- */
      const amountIn2 = ethers.parseEther("1");
      const active1   = await (router as any).getActiveOrbit(startPool);
      const usingNeg1 = active1[1] as boolean;
      const orbit1    = active1[0] as string[];
      expect(usingNeg1).to.equal(false); // now POS

      // Fund + approve for ALL 3 POS pools (per-hop fees)
      {
        const feePerHop = (amountIn2 * 250n) / 10_000n;
        const totalFee  = feePerHop * 3n;
        const totalIn   = amountIn2 * 3n;

        await (await env.asset.connect(deployer).mint(deployer.address, totalIn + totalFee)).wait();
        await (await env.asset.connect(deployer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
        for (const addr of orbit1) {
          await (await env.asset.connect(deployer).approve(addr, amountIn2)).wait();
        }
      }

      const before2 = await snapshot();

      {
        await (router.connect(deployer) as any).mcvSupplication({
          startPool,
          assetToUsdc: true,    // ignored in dual-orbit; cursor controls direction
          amountIn: amountIn2,
          payer: deployer.address,
          to: deployer.address,
        });
      }

      const after2  = await snapshot();
      const deltas2 = after2.pools.map((aft, i) => {
        const bef = before2.pools[i];
        return { pool: aft.pool, deltaA: (aft.a - bef.a).toString(), deltaU: (aft.u - bef.u).toString() };
      });
      const treDelta2 = { deltaA: (after2.treA - before2.treA).toString(), deltaU: (after2.treU - before2.treU).toString() };

      // Flip back to NEG
      const activeAfter2 = await (router as any).getActiveOrbit(startPool);
      expect(activeAfter2[1] as boolean).to.equal(true);

      // Snapshot summary
      expect({
        role: "MCV",
        startPool,
        orbitRun1: { usingNegBefore: usingNeg0, activeOrbit: orbit0, poolDeltas: deltas1, treasuryDelta: treDelta1 },
        orbitRun2: { usingNegBefore: usingNeg1, activeOrbit: orbit1, poolDeltas: deltas2, treasuryDelta: treDelta2 },
        note: "NEG-first under independent 3-hop model (per-hop fees), with explicit per-hop funding/approvals and object params.",
      }).to.matchSnapshot("Dual-orbit — per-pool & treasury deltas + flip");
    });

    it("uses POS set first, flips to NEG after each mcvSupplication; shows per-pool & treasury deltas", async () => {
      const env = await deployCore();
      const { deployer, router, treasury, factory, asset, usdc } = env;

      // Ensure SIX total pools exist
      const have = (await factory.getPools()).length;
      const need = Math.max(0, 6 - have);
      for (let i = 0; i < need; i++) {
        await (
          await treasury.createPoolViaTreasury(
            await factory.getAddress(),
            await asset.getAddress(),
            await usdc.getAddress()
          )
        ).wait();
      }

      // Grab six & bootstrap: first 3 NEG (-500), last 3 POS (+500)
      const all = await factory.getPools();
      const p = all.slice(0, 6);
      for (let i = 0; i < 3; i++) {
        await (await (treasury as any)["bootstrapViaTreasury(address,uint256,uint256,int256)"](
          p[i], ethers.parseEther("100"), ethers.parseEther("100"), -500
        )).wait();
      }
      for (let i = 3; i < 6; i++) {
        await (await (treasury as any)["bootstrapViaTreasury(address,uint256,uint256,int256)"](
          p[i], ethers.parseEther("100"), ethers.parseEther("100"), +500
        )).wait();
      }

      // Wire dual orbit: POS first (startWithNeg = false)
      const startPool = p[0];
      await (
        await (treasury as any).setDualOrbitViaTreasury(
          await router.getAddress(),
          startPool,
          [p[0], p[1], p[2]], // NEG
          [p[3], p[4], p[5]], // POS
          /*startWithNeg*/ false
        )
      ).wait();

      const toPool = async (addr: string) => await ethers.getContractAt("LPPPool", addr);
      const poolObjs = await Promise.all(p.map(toPool));

      const snapshot = async () => {
        const arr = await Promise.all(poolObjs.map(async (po) => {
          const addr = await po.getAddress();
          const a = BigInt((await po.reserveAsset()).toString());
          const u = BigInt((await po.reserveUsdc()).toString());
          return { pool: addr, a, u };
        }));
        const treA = BigInt((await asset.balanceOf(await treasury.getAddress())).toString());
        const treU = BigInt((await usdc.balanceOf(await treasury.getAddress())).toString());
        return { pools: arr, treA, treU };
      };

      /* ----------------------- RUN #1 — POS set (USDC-in due to default cursor) ---------------------- */
      const amountIn1 = ethers.parseEther("1");
      const active0   = await (router as any).getActiveOrbit(startPool);
      const usingNeg0 = active0[1] as boolean;
      const orbit0    = active0[0] as string[];
      expect(usingNeg0).to.equal(false); // POS first (set), direction will be USDC-in by default

      // fund + approve: USDC-in for ALL 3 POS pools (per-hop fees)
      {
        const feePerHop = (amountIn1 * 250n) / 10_000n;
        const totalFee  = feePerHop * 3n;
        const totalIn   = amountIn1 * 3n;

        await (await env.usdc.connect(deployer).mint(deployer.address, totalIn + totalFee)).wait();
        await (await env.usdc.connect(deployer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
        for (const addr of orbit0) {
          await (await env.usdc.connect(deployer).approve(addr, amountIn1)).wait();
        }
      }

      const before1 = await snapshot();

      {
        await (router.connect(deployer) as any).mcvSupplication({
          startPool,
          assetToUsdc: false,     // ignored in dual-orbit; cursor controls direction (USDC-in)
          amountIn: amountIn1,
          payer: deployer.address,
          to: deployer.address,
        });
      }

      const after1  = await snapshot();
      const deltas1 = after1.pools.map((aft, i) => {
        const bef = before1.pools[i];
        return { pool: aft.pool, deltaA: (aft.a - bef.a).toString(), deltaU: (aft.u - bef.u).toString() };
      });
      const treDelta1 = { deltaA: (after1.treA - before1.treA).toString(), deltaU: (after1.treU - before1.treU).toString() };

      // flipped to NEG
      const activeAfter1 = await (router as any).getActiveOrbit(startPool);
      expect(activeAfter1[1] as boolean).to.equal(true);

      /* ----------------------- RUN #2 — NEG set (ASSET-in after flip) ----------------------- */
      const amountIn2 = ethers.parseEther("1");
      const active1   = await (router as any).getActiveOrbit(startPool);
      const usingNeg1 = active1[1] as boolean;
      const orbit1    = active1[0] as string[];
      expect(usingNeg1).to.equal(true); // now NEG set

      // fund + approve: ASSET-in for ALL 3 NEG pools (per-hop fees)
      {
        const feePerHop = (amountIn2 * 250n) / 10_000n;
        const totalFee  = feePerHop * 3n;
        const totalIn   = amountIn2 * 3n;

        await (await env.asset.connect(deployer).mint(deployer.address, totalIn + totalFee)).wait();
        await (await env.asset.connect(deployer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
        for (const addr of orbit1) {
          await (await env.asset.connect(deployer).approve(addr, amountIn2)).wait();
        }
      }

      const before2 = await snapshot();

      {
        await (router.connect(deployer) as any).mcvSupplication({
          startPool,
          assetToUsdc: true,      // ignored in dual-orbit; cursor controls direction (ASSET-in)
          amountIn: amountIn2,
          payer: deployer.address,
          to: deployer.address,
        });
      }

      const after2  = await snapshot();
      const deltas2 = after2.pools.map((aft, i) => {
        const bef = before2.pools[i];
        return { pool: aft.pool, deltaA: (aft.a - bef.a).toString(), deltaU: (aft.u - bef.u).toString() };
      });
      const treDelta2 = { deltaA: (after2.treA - before2.treA).toString(), deltaU: (after2.treU - before2.treU).toString() };

      // flipped back to POS set
      const activeAfter2 = await (router as any).getActiveOrbit(startPool);
      expect(activeAfter2[1] as boolean).to.equal(false);

      expect({
        role: "MCV",
        startPool,
        orbitRun1: { usingNegBefore: usingNeg0, activeOrbit: orbit0, poolDeltas: deltas1, treasuryDelta: treDelta1 },
        orbitRun2: { usingNegBefore: usingNeg1, activeOrbit: orbit1, poolDeltas: deltas2, treasuryDelta: treDelta2 },
        note: "POS-first mirror under independent 3-hop model (per-hop fees); direction follows router cursor (USDC-in first), then flips.",
      }).to.matchSnapshot("Dual-orbit (POS-first) — per-pool & treasury deltas + flip");
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