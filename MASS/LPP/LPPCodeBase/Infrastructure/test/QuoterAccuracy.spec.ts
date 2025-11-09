// test/QuoterAccuracy.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import snapshotGasCost from "./shared/snapshotGasCost.ts";
import { deployCore } from "./helpers.ts";

import type {
  IERC20,
  TestERC20,
  LPPPool,
  LPPRouter,
  LPPMintHook,
  LPPSupplicationQuoter,
} from "../typechain-types/index.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * Config / constants
 * ──────────────────────────────────────────────────────────────────────────── */

// Avoid HH701 artifact ambiguity by using a fully-qualified name
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
 * Generic helpers (typed)
 * ──────────────────────────────────────────────────────────────────────────── */

async function reserves(pool: LPPPool) {
  const a = BigInt((await pool.reserveAsset()).toString());
  const u = BigInt((await pool.reserveUsdc()).toString());
  return { a, u };
}

async function snapshotReserves(pool: LPPPool, label: string) {
  const r = await reserves(pool);
  expect({
    pool: await pool.getAddress(),
    reserves: { asset: r.a.toString(), usdc: r.u.toString() },
  }).to.matchSnapshot(label);
}

async function getTokensFromPool(pool: LPPPool): Promise<{ asset: IERC20; usdc: IERC20 }> {
  const assetAddr = await pool.asset();
  const usdcAddr  = await pool.usdc();

  // Fully-qualified name avoids HH701; we still type them as IERC20
  const asset = (await ethers.getContractAt(IERC20_FQN, assetAddr)) as unknown as IERC20;
  const usdc  = (await ethers.getContractAt(IERC20_FQN, usdcAddr))  as unknown as IERC20;

  return { asset, usdc };
}

async function approveInputForSupplicate(
  token: IERC20,
  payer: any,
  router: LPPRouter,
  pool: LPPPool
) {
  await (await token.connect(payer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
  await (await token.connect(payer).approve(await pool.getAddress(),    ethers.MaxUint256)).wait();
}

async function readTokenBalances(tokens: { asset: IERC20; usdc: IERC20 }, who: string) {
  const a = BigInt((await tokens.asset.balanceOf(who)).toString());
  const u = BigInt((await tokens.usdc.balanceOf(who)).toString());
  return { a, u };
}

/** Mint helper that uses TestERC20 from deployCore (not the IERC20 view handles). */
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

/* ────────────────────────────────────────────────────────────────────────────
 * Sqrt price readers (best-effort, tolerate variant names)
 * ──────────────────────────────────────────────────────────────────────────── */

async function safeReadSqrtPriceX96(pool: any): Promise<bigint | null> {
  const tryFns = [
    "sqrtPriceX96",
    "getSqrtPriceX96",
    "currentSqrtPriceX96",
    "priceX96",
    "slot0" // last resort
  ];

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
 * Robust unpackers for ethers v6 Result/structs (SAFE)
 * ──────────────────────────────────────────────────────────────────────────── */

function toBigIntSafe(v: any): bigint | null {
  if (v === null || v === undefined) return null;
  try {
    return BigInt(v.toString());
  } catch {
    return null;
  }
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

/** Avoid probing numeric-string keys that can throw with ethers v6. */
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
    try { if (sqrtAfter  === null && ret.length > 2) sqrtAfter  = toBigIntSafe(ret[2]); } catch {}
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
  quoter: LPPSupplicationQuoter,
  poolAddr: string,
  assetToUsdc: boolean,
  amountIn: bigint
) {
  const ret = await (quoter as any).quoteSupplication(poolAddr, assetToUsdc, amountIn);
  return unpackQuote(ret);
}

async function getPoolQuotedAmountOut(
  pool: LPPPool,
  assetToUsdc: boolean,
  amountIn: bigint
) {
  const ret = await (pool as any).quoteSupplication(assetToUsdc, amountIn);
  return unpackQuote(ret);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Core snapshot: execute a trade and compare with quotes
 * ──────────────────────────────────────────────────────────────────────────── */

async function snapshotTradeAndCompare(opts: {
  label: string;
  env: {
    deployer: any;
    hook: LPPMintHook;
    router: LPPRouter;
    pool: LPPPool;
    asset: TestERC20;
    usdc: TestERC20;
  };
  assetToUsdc: boolean;
  amountIn: bigint;
  minOut?: bigint;
}) {
  const { label, env, assetToUsdc, amountIn } = opts;
  const minOut = opts.minOut ?? 0n;

  const { deployer, hook, router, pool } = env;
  const who = deployer;

  // Ensure healthy reserves (idempotent ok)
  await (await (hook as any).mintWithRebate({
    pool: await pool.getAddress(),
    to: who.address,
    amountAssetDesired: ethers.parseEther("100"),
    amountUsdcDesired:  ethers.parseEther("100"),
    data: "0x",
  })).wait();

  // IERC20 handles (reads/approvals) and TestERC20 for mint
  const tokens = await getTokensFromPool(pool);

  // Mint input tokens to payer using TestERC20 from env (has .mint)
  await mintToForInput(env, who, assetToUsdc, amountIn);

  // Approvals on router & pool
  if (assetToUsdc) {
    await approveInputForSupplicate(tokens.asset, who, router, pool);
  } else {
    await approveInputForSupplicate(tokens.usdc, who, router, pool);
  }

  // Balances & reserves BEFORE
  const b0 = await readTokenBalances(tokens, who.address);
  const r0 = await reserves(pool);

  const poolAddr = await pool.getAddress();

  // Quotes (quoter + pool + router.staticCall)
  const QuoterF = await ethers.getContractFactory("LPPSupplicationQuoter");
  const quoter = (await QuoterF.deploy()) as unknown as LPPSupplicationQuoter;
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

  // Execute trade
  const tx = await (router.connect(who) as any).supplicate({
    pool: poolAddr,
    assetToUsdc,
    amountIn,
    minAmountOut: minOut,
    to: who.address,
    payer: who.address,
  });
  const rcpt = await tx.wait();
  await snapshotGasCost(rcpt!.gasUsed);

  // Balances & reserves AFTER
  const b1 = await readTokenBalances(tokens, who.address);
  const r1 = await reserves(pool);

  // Determine amountOut from deltas
  let assetOut = 0n, usdcOut = 0n, amountOut = 0n;
  if (assetToUsdc) {
    expect(b0.a - b1.a).to.equal(amountIn);
    usdcOut = b1.u - b0.u;
    expect(usdcOut > 0n).to.equal(true);
    amountOut = usdcOut;
  } else {
    expect(b0.u - b1.u).to.equal(amountIn);
    assetOut = b1.a - b0.a;
    expect(assetOut > 0n).to.equal(true);
    amountOut = assetOut;
  }

  // Sanity: pool deltas align with user deltas
  const poolAOut = r0.a > r1.a ? r0.a - r1.a : 0n;
  const poolUOut = r0.u > r1.u ? r0.u - r1.u : 0n;
  const userAOut = b1.a > b0.a ? b1.a - b0.a : 0n;
  const userUOut = b1.u > b0.u ? b1.u - b0.u : 0n;
  expect(poolAOut).to.equal(userAOut);
  expect(poolUOut).to.equal(userUOut);

  // Current sqrt price (best-effort)
  const sqrtNow = await safeReadSqrtPriceX96(pool);

  // Compare with quotes
  expect(amountOut, "exec vs router.staticCall").to.equal(staticOut);
  expect(amountOut, "exec vs pool.quoteSupplication").to.equal(qPool.amountOut);
  expect(amountOut, "exec vs quoter.quoteSupplication").to.equal(qQuoter.amountOut);

  // Snapshot payload
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

describe("Quoter accuracy & sqrt pricing snapshots", () => {
  it("ABI shape present on Quoter and Pool (quoteSupplication)", async () => {
    const { pool } = await deployCore();

    const QuoterF = await ethers.getContractFactory("LPPSupplicationQuoter");
    const quoter = (await QuoterF.deploy()) as unknown as LPPSupplicationQuoter;
    await quoter.waitForDeployment();

    mustHaveFn(quoter.interface, "quoteSupplication(address,bool,uint256)");
    mustHaveFn(pool.interface,   "quoteSupplication(bool,uint256)");
  });

  it("ASSET->USDC: quote aligns with execution; snapshots deltas & sqrt", async () => {
    const env = await deployCore();
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
    const env = await deployCore();
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
      const { deployer, hook, pool } = await deployCore();
      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("100"),
        amountUsdcDesired:  ethers.parseEther("100"),
        data: "0x",
      })).wait();

      const QuoterF = await ethers.getContractFactory("LPPSupplicationQuoter");
      const quoter = (await QuoterF.deploy()) as unknown as LPPSupplicationQuoter;
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
      const { deployer, hook, pool } = await deployCore();
      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("100"),
        amountUsdcDesired:  ethers.parseEther("100"),
        data: "0x",
      })).wait();

      const QuoterF = await ethers.getContractFactory("LPPSupplicationQuoter");
      const quoter = (await QuoterF.deploy()) as unknown as LPPSupplicationQuoter;
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
      const env = await deployCore();
      const { deployer, hook, pool, router } = env;

      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("100"),
        amountUsdcDesired:  ethers.parseEther("100"),
        data: "0x",
      })).wait();

      const tokens = await getTokensFromPool(pool);
      const tiny = 1n; // 1 wei

      await mintToForInput(env, deployer, true, tiny);
      await approveInputForSupplicate(tokens.asset, deployer, router, pool);

      await snapshotTradeAndCompare({
        label: "tiny — A->U",
        env,
        assetToUsdc: true,
        amountIn: tiny,
        minOut: 0n,
      });
    });

    it("Healthy reserves: tiny input yields non-zero output (U->A)", async () => {
      const env = await deployCore();
      const { deployer, hook, pool, router } = env;

      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("100"),
        amountUsdcDesired:  ethers.parseEther("100"),
        data: "0x",
      })).wait();

      const tokens = await getTokensFromPool(pool);
      const tiny = 1n; // 1 wei

      await mintToForInput(env, deployer, false, tiny);
      await approveInputForSupplicate(tokens.usdc, deployer, router, pool);

      await snapshotTradeAndCompare({
        label: "tiny — U->A",
        env,
        assetToUsdc: false,
        amountIn: tiny,
        minOut: 0n,
      });
    });
  });
});