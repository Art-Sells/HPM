// test/SwapMCV.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import { deployCore } from "./helpers.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * Constants & Interfaces
 * ──────────────────────────────────────────────────────────────────────────── */
const IERC20_FQN = "contracts/external/IERC20.sol:IERC20";

// Router fee split (per hop, on INPUT)
const FEE_BPS        = 12n;   // 0.12%  total per hop
const TREASURY_BPS   = 2n;    // 0.02%  (of input)
const POOLS_DONATE_BPS = 10n; // 0.10%  (of input)
const DENOM          = 10_000n;

/* ────────────────────────────────────────────────────────────────────────────
 * Local helpers
 * ──────────────────────────────────────────────────────────────────────────── */
// alias names used later in assertions
const TREASURY_CUT_BPS = TREASURY_BPS;
const POOLS_CUT_BPS    = POOLS_DONATE_BPS;

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

/** Helper for single-pool tests: force off-center start at −500 bps. */
async function bootstrapPool100_100(
  treasury: any,
  _factoryAddr: string, // unused (kept for backwards compat)
  poolAddr: string,
  _deployerAddr: string // unused
) {
  await bootstrapPoolAtOffset(treasury, poolAddr, -500n);
}
const feeFromInput       = (x: bigint) => (x * FEE_BPS)        / DENOM;
const treasuryCutFromIn  = (x: bigint) => (x * TREASURY_BPS)   / DENOM;
const poolsDonateFromIn  = (x: bigint) => (x * POOLS_DONATE_BPS)/ DENOM;
const abs = (a: bigint) => (a < 0n ? -a : a);
function expectApproxEq(actual: bigint, expected: bigint, tol: bigint = 1n) {
  const diff = abs(actual - expected);
  expect(diff <= tol).to.equal(true, `expected ~${expected} (±${tol}) but got ${actual}`);
}

async function getTokensFromPool(pool: any): Promise<{ asset: any; usdc: any }> {
  const assetAddr = await pool.asset();
  const usdcAddr  = await pool.usdc();
  const asset = await ethers.getContractAt(IERC20_FQN, assetAddr);
  const usdc  = await ethers.getContractAt(IERC20_FQN, usdcAddr);
  return { asset, usdc };
}
const reserves = async (p: any) => ({
  a: BigInt((await p.reserveAsset()).toString()),
  u: BigInt((await p.reserveUsdc()).toString()),
});
const bal = async (t: any, who: string) => BigInt((await t.balanceOf(who)).toString());

/** Approvals for swap:
 *  - Router: fee on tokenIn (pulled each hop)
 *  - Each pool in orbit: principal (amountIn) pulled once per hop
 */
async function prepareSwapApprovals(params: {
  caller: any;
  router: any;
  orbit: string[];
  tokenIn: any;
  amountIn: bigint;
}) {
  const { caller, router, orbit, tokenIn, amountIn } = params;
  await (await tokenIn.connect(caller).approve(await router.getAddress(), ethers.MaxUint256)).wait();
  for (const addr of orbit) {
    await (await tokenIn.connect(caller).approve(addr, amountIn)).wait();
  }
}

/** Integer sqrt for BigInt (Babylonian) */
function isqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x0 = n, x1 = (n >> 1n) + 1n;
  while (x1 < x0) { x0 = x1; x1 = (x1 + n / x1) >> 1n; }
  return x0;
}
/** Implied sqrtPriceX96 from reserves: sqrt((U<<192)/A) */
function impliedSqrtPriceX96FromReserves(a: bigint, u: bigint): bigint {
  if (a === 0n || u === 0n) return 0n;
  const NUM_SHIFTED = u << 192n;
  return isqrt(NUM_SHIFTED / a);
}

/** One-hop CFMM gross out with an extra amount credited to the input reserve *before* the swap. */
function grossOutWithPreAddedInput(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  extraInputBeforeSwap: bigint
): bigint {
  return (amountIn * reserveOut) / (reserveIn + extraInputBeforeSwap + amountIn);
}

/** Simulate 3 hops through the *same* pool (legacy single-orbit = [pool,pool,pool]).
 *  Donations go to the input reserve *before* each hop.
 *  Returns [totalOut, endReserveIn, endReserveOut].
 */
function simulateThreeHopsSamePool(
  assetToUsdc: boolean,
  amountIn: bigint,
  rA0: bigint,
  rU0: bigint
): [bigint, bigint, bigint] {
  let rA = rA0, rU = rU0;
  let totalOut = 0n;

  for (let i = 0; i < 3; i++) {
    const donate = poolsDonateFromIn(amountIn);
    if (assetToUsdc) {
      // donation to ASSET reserve
      rA += donate;
      const out = grossOutWithPreAddedInput(amountIn, rA - donate, rU, donate);
      // apply trade
      rA += amountIn;
      rU -= out;
      totalOut += out;
    } else {
      // donation to USDC reserve
      rU += donate;
      const out = grossOutWithPreAddedInput(amountIn, rU - donate, rA, donate);
      rU += amountIn;
      rA -= out;
      totalOut += out;
    }
  }
  return [totalOut, rA, rU];
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
          if ("0" in v)            return BigInt(v[0].toString());
        }
        continue;
      }
      return BigInt(v.toString());
    } catch {}
  }
  return null;
}

/** Canonicalize addresses so snapshots don't churn on random pool addresses */
const canon = (() => {
  const m = new Map<string, string>();
  return (addr: string) => {
    const a = ethers.getAddress(addr);
    if (!m.has(a)) m.set(a, `POOL#${m.size}`);
    return m.get(a)!;
  };
})();

/* ────────────────────────────────────────────────────────────────────────────
 * Spec
 * ──────────────────────────────────────────────────────────────────────────── */
describe("Swap (MCV)", () => {
it("single-pool legacy orbit (pool×3) — ASSET->USDC, input-fees donated before each hop", async () => {
  const env = await deployCore();
  const { deployer, treasury, router, factory, pool, asset, usdc } = env;

  // bootstrap start pool
  await bootstrapPool100_100(
    treasury,
    await factory.getAddress(),
    await pool.getAddress(),
    deployer.address
  );

  // legacy orbit = the *same* pool used 3×
  const poolAddr = await pool.getAddress();
  await (await (treasury as any).setOrbitViaTreasury(
    await router.getAddress(),
    poolAddr,
    [poolAddr, poolAddr, poolAddr]
  )).wait();

  const amountIn = ethers.parseEther("1");    // per-hop input
  const feePerHop = (amountIn * FEE_BPS) / DENOM;
  const totalFee  = feePerHop * 3n;
  const totalIn   = amountIn * 3n;

  // fund + approve (ASSET-in): router pulls fees; pool pulls principal each hop
  await (await asset.connect(deployer).mint(deployer.address, totalIn + totalFee)).wait();
  await (await asset.connect(deployer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
  // approve Max for pool (hit 3× same pool)
  await (await asset.connect(deployer).approve(poolAddr, ethers.MaxUint256)).wait();

  // BEFORE
  const r0a = BigInt((await pool.reserveAsset()).toString());
  const r0u = BigInt((await pool.reserveUsdc()).toString());
  const t0A = BigInt((await asset.balanceOf(await treasury.getAddress())).toString());
  const b0A = BigInt((await asset.balanceOf(deployer.address)).toString());
  const b0U = BigInt((await usdc.balanceOf(deployer.address)).toString());

  // You can staticCall if you *already* approved (we did)
  await (router.connect(deployer) as any).swap.staticCall({
    startPool: poolAddr,
    assetToUsdc: true,           // legacy mode uses this
    amountIn,
    minTotalAmountOut: 0n,
    to: deployer.address,
    payer: deployer.address,
  });

  // EXECUTE
  const receipt = await (await (router.connect(deployer) as any).swap({
    startPool: poolAddr,
    assetToUsdc: true,
    amountIn,
    minTotalAmountOut: 0n,
    to: deployer.address,
    payer: deployer.address,
  })).wait();

  // AFTER
  const r1a = BigInt((await pool.reserveAsset()).toString());
  const r1u = BigInt((await pool.reserveUsdc()).toString());
  const t1A = BigInt((await asset.balanceOf(await treasury.getAddress())).toString());
  const a1  = BigInt((await asset.balanceOf(deployer.address)).toString());
  const u1  = BigInt((await usdc.balanceOf(deployer.address)).toString());

  // Assertions:
  // - Caller pays 3*amountIn principal + 3*feePerHop (ASSET)
  expect(b0A - a1).to.equal(totalIn + totalFee);

  // - Pool ASSET reserve increases by totalIn + pools-fee-per-hop*3
  const poolsFee3 = (POOLS_CUT_BPS * amountIn * 3n) / DENOM;
  expect(r1a - r0a).to.equal(totalIn + poolsFee3);

  // - Treasury gets 3 * (TREASURY_CUT_BPS on amountIn) in ASSET
  const treInc = t1A - t0A;
  const expectedTre = (TREASURY_CUT_BPS * amountIn * 3n) / DENOM;
  expect(treInc).to.equal(expectedTre);

  // - Three HopExecuted events with assetToUsdc = true, for the same pool
  const HopExecutedSig = ethers.id("HopExecuted(address,bool,address,address,uint256,uint256)");
  const hops = (receipt.logs ?? [])
    .filter((l: any) => l.topics?.[0] === HopExecutedSig)
    .map((l: any) => {
      const poolT     = ethers.getAddress("0x" + l.topics[1].slice(26));
      const tokenInT  = ethers.getAddress("0x" + l.topics[2].slice(26));
      const tokenOutT = ethers.getAddress("0x" + l.topics[3].slice(26));
      const [assetToUsdc, amtIn, amtOut] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["bool","uint256","uint256"],
        l.data
      );
      return { pool: poolT, tokenIn: tokenInT, tokenOut: tokenOutT, assetToUsdc: Boolean(assetToUsdc), amtIn, amtOut };
    });

  expect(hops.length).to.equal(3);
  for (const h of hops) {
    expect(h.pool).to.equal(ethers.getAddress(poolAddr));
    expect(h.assetToUsdc).to.equal(true);
  }

  // Sanity: user received some USDC
  expect(u1 > b0U).to.equal(true);
});

/* ────────────────────────────────────────────────────────────────────────────
 * single-pool legacy orbit (pool×3) — USDC->ASSET, input-fees donated before each hop
 * ──────────────────────────────────────────────────────────────────────────── */
it("single-pool legacy orbit (pool×3) — USDC->ASSET, input-fees donated before each hop", async () => {
  const env = await deployCore();
  const { deployer, treasury, router, factory, pool, asset, usdc } = env;

  // bootstrap start pool
  await bootstrapPool100_100(
    treasury,
    await factory.getAddress(),
    await pool.getAddress(),
    deployer.address
  );

  // legacy orbit = the *same* pool used 3×
  const poolAddr = await pool.getAddress();
  await (await (treasury as any).setOrbitViaTreasury(
    await router.getAddress(),
    poolAddr,
    [poolAddr, poolAddr, poolAddr]
  )).wait();

  const amountIn = ethers.parseEther("1");    // per-hop input
  const feePerHop = (amountIn * FEE_BPS) / DENOM;
  const totalFee  = feePerHop * 3n;
  const totalIn   = amountIn * 3n;

  // fund + approve (USDC-in): router pulls fees; pool pulls principal each hop
  await (await usdc.connect(deployer).mint(deployer.address, totalIn + totalFee)).wait();
  await (await usdc.connect(deployer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
  await (await usdc.connect(deployer).approve(poolAddr, ethers.MaxUint256)).wait();

  // BEFORE
  const r0a = BigInt((await pool.reserveAsset()).toString());
  const r0u = BigInt((await pool.reserveUsdc()).toString());
  const t0U = BigInt((await usdc.balanceOf(await treasury.getAddress())).toString());
  const b0A = BigInt((await asset.balanceOf(deployer.address)).toString());
  const b0U = BigInt((await usdc.balanceOf(deployer.address)).toString());

  // Optional staticCall once approvals are set
  await (router.connect(deployer) as any).swap.staticCall({
    startPool: poolAddr,
    assetToUsdc: false,
    amountIn,
    minTotalAmountOut: 0n,
    to: deployer.address,
    payer: deployer.address,
  });

  // EXECUTE
  const receipt = await (await (router.connect(deployer) as any).swap({
    startPool: poolAddr,
    assetToUsdc: false,
    amountIn,
    minTotalAmountOut: 0n,
    to: deployer.address,
    payer: deployer.address,
  })).wait();

  // AFTER
  const r1a = BigInt((await pool.reserveAsset()).toString());
  const r1u = BigInt((await pool.reserveUsdc()).toString());
  const t1U = BigInt((await usdc.balanceOf(await treasury.getAddress())).toString());
  const a1  = BigInt((await asset.balanceOf(deployer.address)).toString());
  const u1  = BigInt((await usdc.balanceOf(deployer.address)).toString());

  // Assertions:
  // - Caller pays 3*amountIn principal + 3*feePerHop (USDC)
  expect(b0U - u1).to.equal(totalIn + totalFee);

  // - Pool USDC reserve increases by totalIn + pools-fee-per-hop*3
  const poolsFee3 = (POOLS_CUT_BPS * amountIn * 3n) / DENOM;
  expect(r1u - r0u).to.equal(totalIn + poolsFee3);

  // - Treasury gets 3 * (TREASURY_CUT_BPS on amountIn) in USDC
  const treInc = t1U - t0U;
  const expectedTre = (TREASURY_CUT_BPS * amountIn * 3n) / DENOM;
  expect(treInc).to.equal(expectedTre);

  // - Three HopExecuted events with assetToUsdc = false, for the same pool
  const HopExecutedSig = ethers.id("HopExecuted(address,bool,address,address,uint256,uint256)");
  const hops = (receipt.logs ?? [])
    .filter((l: any) => l.topics?.[0] === HopExecutedSig)
    .map((l: any) => {
      const poolT     = ethers.getAddress("0x" + l.topics[1].slice(26));
      const tokenInT  = ethers.getAddress("0x" + l.topics[2].slice(26));
      const tokenOutT = ethers.getAddress("0x" + l.topics[3].slice(26));
      const [assetToUsdc, amtIn, amtOut] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["bool","uint256","uint256"],
        l.data
      );
      return { pool: poolT, tokenIn: tokenInT, tokenOut: tokenOutT, assetToUsdc: Boolean(assetToUsdc), amtIn, amtOut };
    });

  expect(hops.length).to.equal(3);
  for (const h of hops) {
    expect(h.pool).to.equal(ethers.getAddress(poolAddr));
    expect(h.assetToUsdc).to.equal(false);
  }

  // Sanity: user received some ASSET
  expect(a1 > b0A).to.equal(true);
});

  describe("3-pool orbit — liquidity snapshots (with deltas + hop proof)", () => {
it("swap orbit — snapshot pools & treasury, deltas, offsets, hop order", async () => {
  const env = await deployCore();
  const { deployer, router, treasury, factory, asset, usdc } = env;

  // Ensure SIX pools and bootstrap offsets: [-500,-500,-500,+500,+500,+500]
  const have = (await factory.getPools()).length;
  const needToCreate = Math.max(0, 6 - have);
  for (let i = 0; i < needToCreate; i++) {
    await (await treasury.createPoolViaTreasury(
      await factory.getAddress(),
      await asset.getAddress(),
      await usdc.getAddress()
    )).wait();
  }
  const allPools = await factory.getPools();
  const offsets = [-500n, -500n, -500n, 500n, 500n, 500n];
  for (let i = 0; i < 6; i++) {
    await (await (treasury as any)["bootstrapViaTreasury(address,uint256,uint256,int256)"](
      allPools[i], ethers.parseEther("100"), ethers.parseEther("100"), offsets[i]
    )).wait();
  }

  // Orbit = first 3 (shared sign), wire legacy orbit
  const orbitPools = [ allPools[0], allPools[1], allPools[2] ] as [string, string, string];
  const startPoolAddr = orbitPools[0];
  await (await (treasury as any).setOrbitViaTreasury(
    await router.getAddress(),
    startPoolAddr,
    [ orbitPools[0], orbitPools[1], orbitPools[2] ]
  )).wait();

  // Contracts
  const poolA = await ethers.getContractAt("LPPPool", orbitPools[0]);
  const poolB = await ethers.getContractAt("LPPPool", orbitPools[1]);
  const poolC = await ethers.getContractAt("LPPPool", orbitPools[2]);

  // fund + approve (USDC-in for all 3 hops)
  const amountIn = ethers.parseEther("1");
  const feePerHop = (amountIn * FEE_BPS) / DENOM;
  const totalFee  = feePerHop * 3n;
  const totalIn   = amountIn * 3n;

  await (await usdc.connect(deployer).mint(deployer.address, totalIn + totalFee)).wait();
  await (await usdc.connect(deployer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
  for (const addr of orbitPools) {
    await (await usdc.connect(deployer).approve(addr, ethers.MaxUint256)).wait();
  }

  const snap = async (p: any) => {
    const addr = await p.getAddress();
    const a = BigInt((await p.reserveAsset()).toString());
    const u = BigInt((await p.reserveUsdc()).toString());
    let sqrt: bigint | null = null;
    try {
      const v = await p.slot0(); // supports price via slot0 in pool
      if (v && typeof v === "object") {
        if ("sqrtPriceX96" in v) sqrt = BigInt(v.sqrtPriceX96.toString());
        else if ("0" in v)       sqrt = BigInt(v[0].toString());
      }
    } catch {}
    return { pool: addr, a: a.toString(), u: u.toString(), sqrtPriceX96: sqrt?.toString() ?? null };
  };

  // BEFORE
  const pA0 = await snap(poolA);
  const pB0 = await snap(poolB);
  const pC0 = await snap(poolC);
  const t0A = BigInt((await asset.balanceOf(await treasury.getAddress())).toString());
  const t0U = BigInt((await usdc.balanceOf(await treasury.getAddress())).toString());

  // EXECUTE (USDC-in on all 3 hops; legacy mode honors assetToUsdc=false)
  const receipt = await (await (router.connect(deployer) as any).swap({
    startPool: startPoolAddr,
    assetToUsdc: false,
    amountIn,
    minTotalAmountOut: 0n,
    to: deployer.address,
    payer: deployer.address,
  })).wait();

  // AFTER
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

  // HopExecuted decoding (indexed addresses from topics; bool+amounts in data)
  const HopExecutedSig = ethers.id("HopExecuted(address,bool,address,address,uint256,uint256)");
  const hopTrace = (receipt?.logs ?? [])
    .filter((l: any) => l.topics && l.topics[0] === HopExecutedSig)
    .map((l: any) => {
      const pool     = ethers.getAddress("0x" + l.topics[1].slice(26));
      const tokenIn  = ethers.getAddress("0x" + l.topics[2].slice(26));
      const tokenOut = ethers.getAddress("0x" + l.topics[3].slice(26));
      const [assetToUsdc, amtIn, amtOut] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["bool","uint256","uint256"],
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
    executed: true,
    revertReason: null,
    amountIn: amountIn.toString(),
    startPool: startPoolAddr,
    orbitPools,
    offsets: [
      Number(await poolA.targetOffsetBps()),
      Number(await poolB.targetOffsetBps()),
      Number(await poolC.targetOffsetBps()),
    ],
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
    note: "Per-hop fee (12 bps) is charged each hop and donated to that hop’s input reserve; treasury receives 2 bps per hop. Addresses decoded from topics.",
  }).to.matchSnapshot("3-orbit MCV — liquidity+treasury+delta+hop-proof (fixed decoding)");
});
  });

  /* ────────────────────────────────────────────────────────────────────────
   * 3-pool dual-orbit — deltas + automatic flip
   * ──────────────────────────────────────────────────────────────────────── */
  describe("3-pool dual-orbit — deltas + automatic flip", () => {
    it("uses NEG set first, flips to POS after each swap; shows per-pool & treasury deltas", async () => {
      const env = await deployCore();
      const { deployer, router, treasury, factory, asset, usdc } = env;

      // Ensure 6 pools exist and bootstrap 3 NEG, 3 POS
      const have = (await factory.getPools()).length;
      for (let i = have; i < 6; i++) {
        await (await treasury.createPoolViaTreasury(
          await factory.getAddress(), await asset.getAddress(), await usdc.getAddress()
        )).wait();
      }
      const all = await factory.getPools();
      const p = all.slice(-6);
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

      // Wire dual-orbit (start with NEG)
      const startPool = p[0];
      await (await (treasury as any).setDualOrbitViaTreasury(
        await router.getAddress(),
        startPool,
        [p[0], p[1], p[2]], // NEG (ASSET-in)
        [p[3], p[4], p[5]], // POS (USDC-in)
        true
      )).wait();

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

      /* ----------------------- RUN #1 — NEG set (ASSET-in) ----------------------- */
      const amountIn = ethers.parseEther("1");
      const active0   = await (router as any).getActiveOrbit(startPool);
      const usingNeg0 = active0[1] as boolean;
      const orbit0    = active0[0] as string[];
      expect(usingNeg0).to.equal(true);

      // fund + approve ASSET for all three hops
      {
        const feePerHop = feeFromInput(amountIn);
        const totalFee  = feePerHop * 3n;
        const totalIn   = amountIn * 3n;

        await (await env.asset.connect(deployer).mint(deployer.address, totalIn + totalFee)).wait();
        await (await env.asset.connect(deployer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
        for (const addr of orbit0) {
          await (await env.asset.connect(deployer).approve(addr, amountIn)).wait();
        }
      }

      const before1 = await snapshot();
      await (router.connect(deployer) as any).swap({
        startPool,
        assetToUsdc: true, // ignored for dual-orbit; cursor drives direction
        amountIn,
        minTotalAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      });
      const after1  = await snapshot();
      const deltas1 = after1.pools.map((aft, i) => {
        const bef = before1.pools[i];
        return { pool: aft.pool, deltaA: (aft.a - bef.a).toString(), deltaU: (aft.u - bef.u).toString() };
      });
      const treDelta1 = { deltaA: (after1.treA - before1.treA).toString(), deltaU: (after1.treU - before1.treU).toString() };

      // Flipped to POS
      const activeAfter1 = await (router as any).getActiveOrbit(startPool);
      expect(activeAfter1[1] as boolean).to.equal(false);

      /* ----------------------- RUN #2 — POS set (USDC-in) ------------------------ */
      const amountIn2 = ethers.parseEther("1");
      const active1   = await (router as any).getActiveOrbit(startPool);
      const usingNeg1 = active1[1] as boolean;
      const orbit1    = active1[0] as string[];
      expect(usingNeg1).to.equal(false);

      {
        const feePerHop = feeFromInput(amountIn2);
        const totalFee  = feePerHop * 3n;
        const totalIn   = amountIn2 * 3n;

        await (await env.usdc.connect(deployer).mint(deployer.address, totalIn + totalFee)).wait();
        await (await env.usdc.connect(deployer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
        for (const addr of orbit1) {
          await (await env.usdc.connect(deployer).approve(addr, amountIn2)).wait();
        }
      }

      const before2 = await snapshot();
      await (router.connect(deployer) as any).swap({
        startPool,
        assetToUsdc: false, // ignored; POS implies USDC-in
        amountIn: amountIn2,
        minTotalAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      });
      const after2  = await snapshot();
      const deltas2 = after2.pools.map((aft, i) => {
        const bef = before2.pools[i];
        return { pool: aft.pool, deltaA: (aft.a - bef.a).toString(), deltaU: (aft.u - bef.u).toString() };
      });
      const treDelta2 = { deltaA: (after2.treA - before2.treA).toString(), deltaU: (after2.treU - before2.treU).toString() };

      // Flipped back to NEG
      const activeAfter2 = await (router as any).getActiveOrbit(startPool);
      expect(activeAfter2[1] as boolean).to.equal(true);

      // Canonicalize addresses for deterministic snapshots
      const orbit0Canon  = orbit0.map(canon);
      const orbit1Canon  = orbit1.map(canon);
      const deltas1Canon = deltas1.map(d => ({ pool: canon(d.pool), deltaA: d.deltaA, deltaU: d.deltaU }));
      const deltas2Canon = deltas2.map(d => ({ pool: canon(d.pool), deltaA: d.deltaA, deltaU: d.deltaU }));

      expect({
        role: "MCV",
        startPool: canon(startPool),
        orbitRun1: { usingNegBefore: usingNeg0, activeOrbit: orbit0Canon, poolDeltas: deltas1Canon, treasuryDelta: treDelta1 },
        orbitRun2: { usingNegBefore: usingNeg1, activeOrbit: orbit1Canon, poolDeltas: deltas2Canon, treasuryDelta: treDelta2 },
        note: "NEG-first under independent 3-hop model (per-hop fees); run #1 ASSET-in, run #2 USDC-in.",
      }).to.matchSnapshot("Dual-orbit — per-pool & treasury deltas + flip (NEG-first fixed)");
    });

    it("uses POS set first, flips to NEG after each swap; shows per-pool & treasury deltas", async () => {
      const env = await deployCore();
      const { deployer, router, treasury, factory, asset, usdc } = env;

      // Ensure 6 pools exist and bootstrap 3 NEG, 3 POS
      const have = (await factory.getPools()).length;
      for (let i = have; i < 6; i++) {
        await (await treasury.createPoolViaTreasury(
          await factory.getAddress(), await asset.getAddress(), await usdc.getAddress()
        )).wait();
      }
      const all = await factory.getPools();
      const p = all.slice(-6);
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

      // POS first
      const startPool = p[0];
      await (await (treasury as any).setDualOrbitViaTreasury(
        await router.getAddress(),
        startPool,
        [p[0], p[1], p[2]], // NEG
        [p[3], p[4], p[5]], // POS
        false
      )).wait();

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

      /* ----------------------- RUN #1 — POS (USDC-in) ----------------------- */
      const amountIn1 = ethers.parseEther("1");
      const active0   = await (router as any).getActiveOrbit(startPool);
      const usingNeg0 = active0[1] as boolean;
      const orbit0    = active0[0] as string[];
      expect(usingNeg0).to.equal(false);

      {
        const feePerHop = feeFromInput(amountIn1);
        const totalFee  = feePerHop * 3n;
        const totalIn   = amountIn1 * 3n;

        await (await env.usdc.connect(deployer).mint(deployer.address, totalIn + totalFee)).wait();
        await (await env.usdc.connect(deployer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
        for (const addr of orbit0) {
          await (await env.usdc.connect(deployer).approve(addr, amountIn1)).wait();
        }
      }

      const before1 = await snapshot();
      await (router.connect(deployer) as any).swap({
        startPool,
        assetToUsdc: false,
        amountIn: amountIn1,
        minTotalAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      });
      const after1  = await snapshot();
      const deltas1 = after1.pools.map((aft, i) => {
        const bef = before1.pools[i];
        return { pool: aft.pool, deltaA: (aft.a - bef.a).toString(), deltaU: (aft.u - bef.u).toString() };
      });
      const treDelta1 = { deltaA: (after1.treA - before1.treA).toString(), deltaU: (after1.treU - before1.treU).toString() };

      // Flipped to NEG
      const activeAfter1 = await (router as any).getActiveOrbit(startPool);
      expect(activeAfter1[1] as boolean).to.equal(true);

      /* ----------------------- RUN #2 — NEG (ASSET-in) ----------------------- */
      const amountIn2 = ethers.parseEther("1");
      const active1   = await (router as any).getActiveOrbit(startPool);
      const usingNeg1 = active1[1] as boolean;
      const orbit1    = active1[0] as string[];
      expect(usingNeg1).to.equal(true);

      {
        const feePerHop = feeFromInput(amountIn2);
        const totalFee  = feePerHop * 3n;
        const totalIn   = amountIn2 * 3n;

        await (await env.asset.connect(deployer).mint(deployer.address, totalIn + totalFee)).wait();
        await (await env.asset.connect(deployer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
        for (const addr of orbit1) {
          await (await env.asset.connect(deployer).approve(addr, amountIn2)).wait();
        }
      }

      const before2 = await snapshot();
      await (router.connect(deployer) as any).swap({
        startPool,
        assetToUsdc: true,
        amountIn: amountIn2,
        minTotalAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      });
      const after2  = await snapshot();
      const deltas2 = after2.pools.map((aft, i) => {
        const bef = before2.pools[i];
        return { pool: aft.pool, deltaA: (aft.a - bef.a).toString(), deltaU: (aft.u - bef.u).toString() };
      });
      const treDelta2 = { deltaA: (after2.treA - before2.treA).toString(), deltaU: (after2.treU - before2.treU).toString() };

      // Flipped back to POS
      const activeAfter2 = await (router as any).getActiveOrbit(startPool);
      expect(activeAfter2[1] as boolean).to.equal(false);

      const orbit0Canon  = orbit0.map(canon);
      const orbit1Canon  = orbit1.map(canon);
      const deltas1Canon = deltas1.map(d => ({ pool: canon(d.pool), deltaA: d.deltaA, deltaU: d.deltaU }));
      const deltas2Canon = deltas2.map(d => ({ pool: canon(d.pool), deltaA: d.deltaA, deltaU: d.deltaU }));

      expect({
        role: "MCV",
        startPool: canon(startPool),
        orbitRun1: { usingNegBefore: usingNeg0, activeOrbit: orbit0Canon, poolDeltas: deltas1Canon, treasuryDelta: treDelta1 },
        orbitRun2: { usingNegBefore: usingNeg1, activeOrbit: orbit1Canon, poolDeltas: deltas2Canon, treasuryDelta: treDelta2 },
        note: "POS-first mirror under independent 3-hop model (per-hop fees).",
      }).to.matchSnapshot("Dual-orbit (POS-first) — per-pool & treasury deltas + flip");
    });
  });

  describe("Bypass guard via direct token movement (MCV path)", () => {
    it("ERC20.transfer / transferFrom to pool must NOT mutate reserves", async () => {
      const env = await deployCore();
      const { deployer, treasury, factory, pool } = env;

      await (await (treasury as any)["bootstrapViaTreasury(address,uint256,uint256,int256)"](
        await pool.getAddress(), ethers.parseEther("100"), ethers.parseEther("100"), 0
      )).wait();

      const { asset, usdc } = await getTokensFromPool(pool);
      const poolAddr = await pool.getAddress();

      const r0 = await reserves(pool);

      const amt = ethers.parseEther("5");
      const twice = amt * 2n;

      await (await env.asset.connect(deployer).mint(deployer.address, twice)).wait();
      await (await env.usdc.connect(deployer).mint(deployer.address, twice)).wait();

      // direct transfers
      await (await asset.connect(deployer).transfer(poolAddr, amt)).wait();
      await (await usdc.connect(deployer).transfer(poolAddr, amt)).wait();

      // transferFrom into pool
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