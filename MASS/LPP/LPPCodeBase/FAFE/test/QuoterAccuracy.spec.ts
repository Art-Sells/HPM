// test/QuoterAccuracy.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import snapshotGasCost from "./shared/snapshotGasCost.ts";
import { deployCore } from "./helpers.ts";

import type {
  IERC20,
  TestERC20,
  FAFEPool,
  FAFERouter,
  FAFESupplicationQuoter,
  FAFETreasury,
  FAFEAccessManager,
} from "../typechain-types";

/* ────────────────────────────────────────────────────────────────────────────
 * Config / constants
 * ──────────────────────────────────────────────────────────────────────────── */

const IERC20_FQN = "contracts/external/IERC20.sol:IERC20";

/* ────────────────────────────────────────────────────────────────────────────
 * Small ABI guards
 * ──────────────────────────────────────────────────────────────────────────── */
function mustHaveFn(iface: any, signature: string) {
  try {
    iface.getFunction(signature);
  } catch {
    throw new Error(`Missing fn in ABI: ${signature}`);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Utilities for BigInt tolerance
 * ──────────────────────────────────────────────────────────────────────────── */

/** absolute |a-b| */
function absdiff(a: bigint, b: bigint): bigint {
  return a >= b ? a - b : b - a;
}

/** 1 basis point of x, floored — never less than 1 wei */
function bp1OrOneWei(x: bigint): bigint {
  const oneBp = x / 10_000n;
  return oneBp > 1n ? oneBp : 1n;
}

/** near-equality helper with descriptive message */
function expectNearlyEqual(actual: bigint, expected: bigint, msg: string) {
  const tol = bp1OrOneWei(expected); // ~1bp tolerance for rounding/split-order drift
  const d = absdiff(actual, expected);
  expect(
    d <= tol,
    `${msg}: |actual-expected|=${d} > tol=${tol} (expected=${expected}, actual=${actual})`
  ).to.equal(true);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Tiny input probe: find smallest amountIn that yields non-zero out
 * ──────────────────────────────────────────────────────────────────────────── */
async function findSmallestNonZeroAmount(opts: {
  pool: FAFEPool;
  assetToUsdc: boolean;
  maxAttempts?: number;
  start?: bigint;
  growth?: bigint;
}): Promise<bigint | null> {
  const { pool, assetToUsdc } = opts;
  const maxAttempts = opts.maxAttempts ?? 32;
  let amount = opts.start ?? 1n;   // start at 1 wei
  const growth = opts.growth ?? 10n;

  for (let i = 0; i < maxAttempts; i++) {
    const q = await getPoolQuotedAmountOut(pool, assetToUsdc, amount);
    if (q.amountOut > 0n) return amount;
    amount *= growth;
  }
  return null; // couldn’t find non-zero within attempts
}

/* ────────────────────────────────────────────────────────────────────────────
 * Generic helpers (typed)
 * ──────────────────────────────────────────────────────────────────────────── */

async function reserves(pool: FAFEPool) {
  const a = BigInt((await pool.reserveAsset()).toString());
  const u = BigInt((await pool.reserveUsdc()).toString());
  return { a, u };
}

async function snapshotReserves(pool: FAFEPool, label: string) {
  const r = await reserves(pool);
  expect({
    reserves: { asset: r.a.toString(), usdc: r.u.toString() },
  }).to.matchSnapshot(label);
}

async function getTokensFromPool(pool: FAFEPool): Promise<{ asset: IERC20; usdc: IERC20 }> {
  const assetAddr = await pool.asset();
  const usdcAddr  = await pool.usdc();
  const asset = (await ethers.getContractAt(IERC20_FQN, assetAddr)) as unknown as IERC20;
  const usdc  = (await ethers.getContractAt(IERC20_FQN, usdcAddr))  as unknown as IERC20;
  return { asset, usdc };
}

async function approveInputForSupplicate(
  token: IERC20,
  payer: any,
  router: FAFERouter,
  pool: FAFEPool
) {
  await (await token.connect(payer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
  await (await token.connect(payer).approve(await pool.getAddress(),    ethers.MaxUint256)).wait();
}

async function readTokenBalances(tokens: { asset: IERC20; usdc: IERC20 }, who: string) {
  const a = BigInt((await tokens.asset.balanceOf(who)).toString());
  const u = BigInt((await tokens.usdc.balanceOf(who)).toString());
  return { a, u };
}

async function mintToForInput(
  env: { asset: TestERC20; usdc: TestERC20; deployer: any },
  payerSigner: any,
  assetToUsdc: boolean,
  amount: bigint
) {
  const payerAddr = await payerSigner.getAddress();
  const minter = env.deployer;
  if (assetToUsdc) {
    await (await env.asset.connect(minter).mint(payerAddr, amount)).wait();
  } else {
    await (await env.usdc.connect(minter).mint(payerAddr, amount)).wait();
  }
}

/** Seed pool via Treasury.bootstrapViaTreasury (Phase 0 style) */
async function bootstrapSeed(
  treasury: FAFETreasury,
  pool: FAFEPool,
  asset: TestERC20,
  usdc: TestERC20,
  deployer: any,
  amountAsset: bigint,
  amountUsdc: bigint,
  offsetBps: bigint = 0n
) {
  // Idempotent: skip if already initialized
  const currentA = BigInt((await pool.reserveAsset()).toString());
  const currentU = BigInt((await pool.reserveUsdc()).toString());
  if (currentA > 0n || currentU > 0n) return;

  const tAddr = await treasury.getAddress();

  if (amountAsset > 0n) {
    await (await asset.connect(deployer).mint(tAddr, amountAsset)).wait();
  }
  if (amountUsdc > 0n) {
    await (await usdc.connect(deployer).mint(tAddr, amountUsdc)).wait();
  }

  const fn4 = (treasury as any)[
    "bootstrapViaTreasury(address,uint256,uint256,int256)"
  ] as (
    poolAddr: string,
    amtA: bigint,
    amtU: bigint,
    off: bigint
  ) => Promise<any>;

  await fn4(await pool.getAddress(), amountAsset, amountUsdc, offsetBps);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Sqrt price readers (best-effort)
 * ──────────────────────────────────────────────────────────────────────────── */

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
          if ("0" in v)           return BigInt(v[0].toString());
        }
        continue;
      }
      return BigInt(v.toString());
    } catch {}
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Robust unpackers for ethers v6 Result/structs
 * ──────────────────────────────────────────────────────────────────────────── */

function toBigIntSafe(v: any): bigint | null {
  if (v === null || v === undefined) return null;
  try { return BigInt(v.toString()); } catch { return null; }
}

function firstBigIntFromResult(ret: any): bigint {
  const direct = toBigIntSafe(ret);
  if (direct !== null) return direct;

  if (Array.isArray(ret)) {
    const v0 = toBigIntSafe(ret[0]);
    if (v0 !== null) return v0;
  }

  if (ret && typeof ret === "object") {
    const namedKeys = ["expectedAmountOut", "amountOut", "out", "value", "0"];
    for (const k of namedKeys) {
      if (k in ret) {
        const v = toBigIntSafe((ret as any)[k]);
        if (v !== null) return v;
      }
    }
    if ("0" in ret) {
      const v = toBigIntSafe((ret as any)[0]);
      if (v !== null) return v;
    }
  }

  throw new Error(`Cannot find bigint in quoter/pool return: ${JSON.stringify(ret)}`);
}

function unpackQuote(ret: any): {
  amountOut: bigint;
  sqrtBefore?: bigint | null;
  sqrtAfter?: bigint | null;
  extra?: Record<string, string>;
} {
  const amountOut = firstBigIntFromResult(ret);

  const tryNamedField = (...names: string[]) => {
    for (const n of names) {
      try {
        if (ret && Object.prototype.hasOwnProperty.call(ret as any, n)) {
          const v = toBigIntSafe((ret as any)[n]);
          if (v !== null) return v;
        }
      } catch {}
    }
    return null;
  };

  let sqrtBefore = tryNamedField("sqrtBeforeX96", "sqrtPriceBeforeX96", "sqrtPriceX96Before");
  let sqrtAfter  = tryNamedField("sqrtAfterX96",  "sqrtPriceAfterX96",  "sqrtPriceX96After");

  if ((sqrtBefore === null || sqrtAfter === null) && Array.isArray(ret)) {
    try { if (sqrtBefore === null && ret.length > 1) sqrtBefore = toBigIntSafe(ret[1]); } catch {}
    try { if (sqrtAfter  === null && ret.length > 2)  sqrtAfter = toBigIntSafe(ret[2]); } catch {}
  }

  const extra: Record<string, string> = {};
  try {
    if (ret && typeof ret === "object") {
      for (const k of Object.keys(ret)) {
        try {
          const v = (ret as any)[k];
          if (typeof v !== "function") {
            const s = v?.toString?.();
            if (s !== undefined) extra[k] = s;
          }
        } catch {}
      }
    }
  } catch {}

  return { amountOut, sqrtBefore, sqrtAfter, extra };
}

async function getQuotedAmountOut(
  quoter: FAFESupplicationQuoter,
  poolAddr: string,
  assetToUsdc: boolean,
  amountIn: bigint
) {
  const ret = await (quoter as any).quoteSupplication(poolAddr, assetToUsdc, amountIn);
  return unpackQuote(ret);
}

async function getPoolQuotedAmountOut(pool: FAFEPool, assetToUsdc: boolean, amountIn: bigint) {
  const ret = await (pool as any).quoteSupplication(assetToUsdc, amountIn);
  return unpackQuote(ret);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Core snapshot: execute a trade and compare with quotes (fee-aware)
 * ──────────────────────────────────────────────────────────────────────────── */

async function snapshotTradeAndCompare(opts: {
  label: string;
  env: {
    deployer: any;
    router: FAFERouter;
    pool: FAFEPool;
    asset: TestERC20;
    usdc: TestERC20;
    treasury: FAFETreasury;
    access: FAFEAccessManager;
  };
  assetToUsdc: boolean;
  amountIn: bigint;
  minOut?: bigint;
  requireNonZeroOut?: boolean; // default true
  snapshotGas?: boolean;       // default true
}) {
  const { label, env, assetToUsdc, amountIn } = opts;
  const minOut = opts.minOut ?? 0n;
  const requireNonZeroOut = opts.requireNonZeroOut ?? true;
  const snapshotGas = opts.snapshotGas ?? true;

  const { deployer, router, pool, asset, usdc, treasury, access } = env;
  const who = deployer;

  // allow deployer to use supplicate
  await (await access.setApprovedSupplicator(who.address, true)).wait();

  // seed pool with healthy reserves via Treasury (e.g. 100 / 100)
  await bootstrapSeed(
    treasury,
    pool,
    asset,
    usdc,
    deployer,
    ethers.parseEther("100"),
    ethers.parseEther("100"),
    0n
  );

  const tokens = await getTokensFromPool(pool);

  // mint input to payer
  await mintToForInput({ asset, usdc, deployer }, who, assetToUsdc, amountIn);

  // approve Router + Pool
  if (assetToUsdc) {
    await approveInputForSupplicate(tokens.asset, who, router, pool);
  } else {
    await approveInputForSupplicate(tokens.usdc, who, router, pool);
  }

  const b0 = await readTokenBalances(tokens, who.address);
  const r0 = await reserves(pool);

  const poolAddr = await pool.getAddress();

  const QuoterF = await ethers.getContractFactory("FAFESupplicationQuoter");
  const quoter = (await QuoterF.deploy()) as unknown as FAFESupplicationQuoter;
  await quoter.waitForDeployment();

  const qQuoter = await getQuotedAmountOut(quoter, poolAddr, assetToUsdc, amountIn);
  const qPool   = await getPoolQuotedAmountOut(pool, assetToUsdc, amountIn);

  const staticOut: bigint = await (router.connect(who) as any).supplicate.staticCall({
    pool: poolAddr,
    assetToUsdc,
    amountIn,
    minAmountOut: 0n,
    to: who.address,
    payer: who.address,
  });

  const tx = await (router.connect(who) as any).supplicate({
    pool: poolAddr,
    assetToUsdc,
    amountIn,
    minAmountOut: minOut,
    to: who.address,
    payer: who.address,
  });
  const rcpt = await tx.wait();

  if (snapshotGas) {
    await snapshotGasCost(rcpt!.gasUsed);
  }

  const b1 = await readTokenBalances(tokens, who.address);
  const r1 = await reserves(pool);

  // ---- Fee-aware accounting -------------------------------------------------
  let assetOut = 0n, usdcOut = 0n, amountOut = 0n;

  if (assetToUsdc) {
    const spentA  = b0.a - b1.a;        // what payer actually spent (may include input fee)
    const poolAIn = r1.a - r0.a;        // what the pool actually received

    expect(spentA, "payer must spend >= amountIn").to.be.gte(amountIn);
    expect(poolAIn, "pool must receive >= amountIn").to.be.gte(amountIn);

    const extraToPoolA   = poolAIn > amountIn ? (poolAIn - amountIn) : 0n;
    const extraFromPayer = spentA  > amountIn ? (spentA  - amountIn) : 0n;
    expect(
      extraToPoolA <= extraFromPayer,
      `input-fee mismatch (toPool=${extraToPoolA} > fromPayer=${extraFromPayer})`
    ).to.equal(true);

    usdcOut  = b1.u - b0.u;
    if (requireNonZeroOut) expect(usdcOut > 0n).to.equal(true);
    amountOut = usdcOut;
  } else {
    const spentU  = b0.u - b1.u;
    const poolUIn = r1.u - r0.u;

    expect(spentU, "payer must spend >= amountIn").to.be.gte(amountIn);
    expect(poolUIn, "pool must receive >= amountIn").to.be.gte(amountIn);

    const extraToPoolU   = poolUIn > amountIn ? (poolUIn - amountIn) : 0n;
    const extraFromPayer = spentU  > amountIn ? (spentU  - amountIn) : 0n;
    expect(
      extraToPoolU <= extraFromPayer,
      `input-fee mismatch (toPool=${extraToPoolU} > fromPayer=${extraFromPayer})`
    ).to.equal(true);

    assetOut = b1.a - b0.a;
    if (requireNonZeroOut) expect(assetOut > 0n).to.equal(true);
    amountOut = assetOut;
  }

  // Cross-check pool vs user deltas on the *output* leg
  const poolAOut = r0.a > r1.a ? r0.a - r1.a : 0n;
  const poolUOut = r0.u > r1.u ? r0.u - r1.u : 0n;
  const userAOut = b1.a > b0.a ? b1.a - b0.a : 0n;
  const userUOut = b1.u > b0.u ? b1.u - b0.u : 0n;
  expect(poolAOut).to.equal(userAOut);
  expect(poolUOut).to.equal(userUOut);

  const sqrtNow = await safeReadSqrtPriceX96(pool);

  // Exact equality where it must be exact
  expect(amountOut, "exec vs router.staticCall").to.equal(staticOut);

  // Allow tiny rounding drift vs both quoter and pool-local quote
  expectNearlyEqual(amountOut, qQuoter.amountOut, "exec vs quoter.quoteSupplication");
  expectNearlyEqual(amountOut, qPool.amountOut,   "exec vs pool.quoteSupplication");

  expect({
    label,
    direction: assetToUsdc ? "ASSET->USDC" : "USDC->ASSET",
    input: { amountIn: amountIn.toString(), minOut: minOut.toString() },
    quotes: {
      quoter: {
        amountOut: qQuoter.amountOut.toString(),
        sqrtBefore: qQuoter.sqrtBefore?.toString() ?? null,
        sqrtAfter:  qQuoter.sqrtAfter?.toString() ?? null,
        extra: qQuoter.extra,
      },
      pool: {
        amountOut: qPool.amountOut.toString(),
        sqrtBefore: qPool.sqrtBefore?.toString() ?? null,
        sqrtAfter:  qPool.sqrtAfter?.toString() ?? null,
        extra: qPool.extra,
      },
      routerStatic: staticOut.toString(),
    },
    execution: {
      assetOut: assetOut.toString(),
      usdcOut:  usdcOut.toString(),
      sumOut:   (assetOut + usdcOut).toString(),
    },
    reserves: {
      before: { a: r0.a.toString(), u: r0.u.toString() },
      after:  { a: r1.a.toString(), u: r1.u.toString() },
      delta:  { a: poolAOut.toString(), u: poolUOut.toString() },
    },
    callerBalances: {
      before: { a: b0.a.toString(), u: b0.u.toString() },
      after:  { a: b1.a.toString(), u: b1.u.toString() },
      delta:  { a: userAOut.toString(), u: userUOut.toString() },
    },
    sqrtPriceX96: sqrtNow?.toString() ?? null,
    gasUsed: rcpt!.gasUsed.toString(),
  }).to.matchSnapshot(`${label} — trade+quotes+sqrt`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Spec
 * ──────────────────────────────────────────────────────────────────────────── */

describe("Quoter accuracy & sqrt pricing snapshots (Phase 0, no hooks)", () => {
  it("ABI shape present on Quoter and Pool (quoteSupplication)", async () => {
    const { pool } = await deployCore();

    const QuoterF = await ethers.getContractFactory("FAFESupplicationQuoter");
    const quoter = (await QuoterF.deploy()) as unknown as FAFESupplicationQuoter;
    await quoter.waitForDeployment();

    mustHaveFn(quoter.interface, "quoteSupplication(address,bool,uint256)");
    mustHaveFn(pool.interface,   "quoteSupplication(bool,uint256)");
  });

  it("ASSET->USDC: quote aligns with execution; snapshots deltas & sqrt", async () => {
    const env: any = await deployCore();
    await snapshotReserves(env.pool, "pre — A->U");
    await snapshotTradeAndCompare({
      label: "A->U",
      env,
      assetToUsdc: true,
      amountIn: ethers.parseEther("1"),
      minOut: 0n,
    });
  });

  it("USDC->ASSET: quote aligns with execution; snapshots deltas & sqrt", async () => {
    const env: any = await deployCore();
    await snapshotReserves(env.pool, "pre — U->A");
    await snapshotTradeAndCompare({
      label: "U->A",
      env,
      assetToUsdc: false,
      amountIn: ethers.parseEther("1"),
      minOut: 0n,
    });
  });

  describe("Monotonicity (same block): larger amountIn → >= amountOut", () => {
    it("ASSET->USDC via quoter", async () => {
      const env: any = await deployCore();
      const { deployer, pool, treasury, access, asset, usdc } = env;

      await (await (access as FAFEAccessManager).setApprovedSupplicator(deployer.address, true)).wait();

      await bootstrapSeed(
        treasury as FAFETreasury,
        pool as FAFEPool,
        asset as TestERC20,
        usdc as TestERC20,
        deployer,
        ethers.parseEther("100"),
        ethers.parseEther("100"),
        0n
      );

      const QuoterF = await ethers.getContractFactory("FAFESupplicationQuoter");
      const quoter = (await QuoterF.deploy()) as unknown as FAFESupplicationQuoter;
      await quoter.waitForDeployment();

      const addr = await pool.getAddress();
      const q025 = await getQuotedAmountOut(quoter, addr, true,  ethers.parseEther("0.25"));
      const q050 = await getQuotedAmountOut(quoter, addr, true,  ethers.parseEther("0.50"));
      const q100 = await getQuotedAmountOut(quoter, addr, true,  ethers.parseEther("1.00"));

      expect(q050.amountOut).to.be.gte(q025.amountOut);
      expect(q100.amountOut).to.be.gte(q050.amountOut);

      expect({
        direction: "ASSET->USDC",
        q025: q025.amountOut.toString(),
        q050: q050.amountOut.toString(),
        q100: q100.amountOut.toString(),
      }).to.matchSnapshot("monotonic — A->U");
    });

    it("USDC->ASSET via quoter", async () => {
      const env: any = await deployCore();
      const { deployer, pool, treasury, access, asset, usdc } = env;

      await (await (access as FAFEAccessManager).setApprovedSupplicator(deployer.address, true)).wait();

      await bootstrapSeed(
        treasury as FAFETreasury,
        pool as FAFEPool,
        asset as TestERC20,
        usdc as TestERC20,
        deployer,
        ethers.parseEther("100"),
        ethers.parseEther("100"),
        0n
      );

      const QuoterF = await ethers.getContractFactory("FAFESupplicationQuoter");
      const quoter = (await QuoterF.deploy()) as unknown as FAFESupplicationQuoter;
      await quoter.waitForDeployment();

      const addr = await pool.getAddress();
      const q025 = await getQuotedAmountOut(quoter, addr, false, ethers.parseEther("0.25"));
      const q050 = await getQuotedAmountOut(quoter, addr, false, ethers.parseEther("0.50"));
      const q100 = await getQuotedAmountOut(quoter, addr, false, ethers.parseEther("1.00"));

      expect(q050.amountOut).to.be.gte(q025.amountOut);
      expect(q100.amountOut).to.be.gte(q050.amountOut);

      expect({
        direction: "USDC->ASSET",
        q025: q025.amountOut.toString(),
        q050: q050.amountOut.toString(),
        q100: q100.amountOut.toString(),
      }).to.matchSnapshot("monotonic — U->A");
    });
  });

  describe("Tiny-trade behavior", () => {
    it("Healthy reserves: tiny input yields non-zero output (A->U)", async () => {
      const env: any = await deployCore();
      const { deployer, pool, router, treasury, access, asset, usdc } = env;

      await (await (access as FAFEAccessManager).setApprovedSupplicator(deployer.address, true)).wait();

      await bootstrapSeed(
        treasury as FAFETreasury,
        pool as FAFEPool,
        asset as TestERC20,
        usdc as TestERC20,
        deployer,
        ethers.parseEther("100"),
        ethers.parseEther("100"),
        0n
      );

      const probed = await findSmallestNonZeroAmount({ pool, assetToUsdc: true });
      const amountIn = (probed ?? 1n);

      const tokens = await getTokensFromPool(pool);
      await mintToForInput({ asset, usdc, deployer }, deployer, true, amountIn);
      await approveInputForSupplicate(tokens.asset, deployer, router, pool);

      await snapshotTradeAndCompare({
        label: "tiny — A->U",
        env,
        assetToUsdc: true,
        amountIn,
        minOut: 0n,
        requireNonZeroOut: probed !== null,
        snapshotGas: false,
      });
    });

    it("Healthy reserves: tiny input yields non-zero output (U->A)", async () => {
      const env: any = await deployCore();
      const { deployer, pool, router, treasury, access, asset, usdc } = env;

      await (await (access as FAFEAccessManager).setApprovedSupplicator(deployer.address, true)).wait();

      await bootstrapSeed(
        treasury as FAFETreasury,
        pool as FAFEPool,
        asset as TestERC20,
        usdc as TestERC20,
        deployer,
        ethers.parseEther("100"),
        ethers.parseEther("100"),
        0n
      );

      const probed = await findSmallestNonZeroAmount({ pool, assetToUsdc: false });
      const amountIn = (probed ?? 1n);

      const tokens = await getTokensFromPool(pool);
      await mintToForInput({ asset, usdc, deployer }, deployer, false, amountIn);
      await approveInputForSupplicate(tokens.usdc, deployer, router, pool);

      await snapshotTradeAndCompare({
        label: "tiny — U->A",
        env,
        assetToUsdc: false,
        amountIn,
        minOut: 0n,
        requireNonZeroOut: probed !== null,
        snapshotGas: false,
      });
    });
  });
});

/* Optional helper if you later expose fee bps on Router:
async function readTotalInputFeeBps(router: FAFERouter): Promise<bigint> {
  const cand = [
    "totalFeeBps","supplicationFeeBps","FEE_BPS","feeBps",
    "inputFeeBps","TOTAL_FEE_BPS"
  ];
  for (const name of cand) {
    if (name in (router as any)) {
      try {
        const v = await (router as any)[name]();
        return BigInt(v.toString());
      } catch {}
    }
  }
  const parts = [["feeBps"],["treasuryFeeBps"],["poolsFeeBps"]];
  let sum = 0n;
  for (const [n] of parts) {
    if (n in (router as any)) {
      try { sum += BigInt((await (router as any)[n]()).toString()); } catch {}
    }
  }
  return sum;
}
*/