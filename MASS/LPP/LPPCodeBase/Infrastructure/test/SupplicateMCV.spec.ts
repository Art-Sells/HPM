// test/SupplicateMCV.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import { deployCore } from "./helpers.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * Interfaces & constants
 * ──────────────────────────────────────────────────────────────────────────── */
const IERC20_FQN = "contracts/external/IERC20.sol:IERC20";

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers (mirrors SupplicateApproved.spec.ts)
 * ──────────────────────────────────────────────────────────────────────────── */
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
  await (await token.connect(payer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
  await (await token.connect(payer).approve(await pool.getAddress(),    ethers.MaxUint256)).wait();
}

/** Best-effort sqrt reader supporting multiple shapes (slot0, priceX96, etc.) */
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

async function getPoolQuotedAmountOut(pool: any, assetToUsdc: boolean, amountIn: bigint) {
  try {
    const ret = await (pool as any).quoteSupplication(assetToUsdc, amountIn);
    const toBig = (x: any) => BigInt(x.toString());
    if (ret && typeof ret === "object") {
      if ("amountOut" in ret) return toBig(ret.amountOut);
      if ("0" in ret)         return toBig(ret[0]);
    }
    if (Array.isArray(ret) && ret.length > 0) return toBig(ret[0]);
    return BigInt(ret.toString());
  } catch {
    return 0n;
  }
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

/* ────────────────────────────────────────────────────────────────────────────
 * Spec
 * ──────────────────────────────────────────────────────────────────────────── */
describe("Supplicate (MCV)", () => {
  it("LP-MCV executes rebalance — ASSET->USDC", async () => {
    const env = await deployCore();
    const { deployer, access, hook, pool, router } = env;

    // Seed pool (100/100)
    await (await hook.mintWithRebate({
      pool: await pool.getAddress(),
      to: deployer.address,
      amountAssetDesired: ethers.parseEther("100"),
      amountUsdcDesired:  ethers.parseEther("100"),
      data: "0x",
    })).wait();

    // Treat the MCV as a privileged supplicator; here we simply approve `deployer` (your MCV) to act.
    await (await access.setApprovedSupplicator(deployer.address, true)).wait();

    const amountIn = ethers.parseEther("1");
    const { asset, usdc } = await getTokensFromPool(pool);

    // Fund MCV with input side (asset -> usdc)
    await (await env.asset.connect(deployer).mint(deployer.address, amountIn)).wait();
    await approveInputForSupplicate(asset, deployer, router, pool);

    // Snapshots before
    const r0 = await reserves(pool);
    const s0Stored  = await safeReadSqrtPriceX96(pool);
    const s0Implied = impliedSqrtPriceX96FromReserves(r0.a, r0.u);
    const b0A = await bal(asset, deployer.address);
    const b0U = await bal(usdc,  deployer.address);

    // Quotes
    const quoted = await getPoolQuotedAmountOut(pool, /*assetToUsdc*/ true, amountIn);
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
    } catch { staticOut = null; }

    // Execute
    await expect((router.connect(deployer) as any).supplicate({
      pool: await pool.getAddress(),
      assetToUsdc: true,
      amountIn,
      minAmountOut: 0n,
      to: deployer.address,
      payer: deployer.address,
    })).not.to.be.reverted;

    // After
    const r1 = await reserves(pool);
    const s1Stored  = await safeReadSqrtPriceX96(pool);
    const s1Implied = impliedSqrtPriceX96FromReserves(r1.a, r1.u);
    const a1 = await bal(asset, deployer.address);
    const u1 = await bal(usdc,  deployer.address);

    // Basic correctness
    expect(b0A - a1).to.equal(amountIn);
    expect(u1 >= b0U).to.equal(true);
    if (quoted > 0n)      expect(u1 - b0U).to.equal(quoted);
    if (staticOut !== null) expect(u1 - b0U).to.equal(staticOut!);

    // Reserves ↔ caller deltas
    const poolAOut = r0.a > r1.a ? r0.a - r1.a : 0n;
    const poolUOut = r0.u > r1.u ? r0.u - r1.u : 0n;
    const userAOut = a1 > b0A ? a1 - b0A : 0n;
    const userUOut = u1 > b0U ? u1 - b0U : 0n;
    expect(poolAOut).to.equal(userAOut);
    expect(poolUOut).to.equal(userUOut);

    // Directional price check (ASSET->USDC → implied sqrt decreases)
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
        after:  { a: r1.a.toString(), u: r1.u.toString() },
      },
      callerBalances: {
        before: { a: b0A.toString(), u: b0U.toString() },
        after:  { a: a1.toString(),  u: u1.toString()  },
      },
      sqrtPriceX96: {
        stored:  { before: s0Stored?.toString() ?? null, after: s1Stored?.toString() ?? null },
        implied: { before: s0Implied.toString(),         after:  s1Implied.toString() }
      }
    }).to.matchSnapshot("MCV — first supplicate A->U");
  });

  it("LP-MCV executes rebalance — USDC->ASSET", async () => {
    const env = await deployCore();
    const { deployer, access, hook, pool, router } = env;

    // Seed pool (100/100)
    await (await hook.mintWithRebate({
      pool: await pool.getAddress(),
      to: deployer.address,
      amountAssetDesired: ethers.parseEther("100"),
      amountUsdcDesired:  ethers.parseEther("100"),
      data: "0x",
    })).wait();

    await (await access.setApprovedSupplicator(deployer.address, true)).wait();

    const amountIn = ethers.parseEther("1");
    const { asset, usdc } = await getTokensFromPool(pool);

    // Fund MCV with USDC input
    await (await env.usdc.connect(deployer).mint(deployer.address, amountIn)).wait();
    await approveInputForSupplicate(usdc, deployer, router, pool);

    const r0 = await reserves(pool);
    const s0Stored  = await safeReadSqrtPriceX96(pool);
    const s0Implied = impliedSqrtPriceX96FromReserves(r0.a, r0.u);
    const b0A = await bal(asset, deployer.address);
    const b0U = await bal(usdc,  deployer.address);

    const quoted = await getPoolQuotedAmountOut(pool, /*assetToUsdc*/ false, amountIn);

    await (router.connect(deployer) as any).supplicate({
      pool: await pool.getAddress(),
      assetToUsdc: false,
      amountIn,
      minAmountOut: 0n,
      to: deployer.address,
      payer: deployer.address,
    });

    const r1 = await reserves(pool);
    const s1Stored  = await safeReadSqrtPriceX96(pool);
    const s1Implied = impliedSqrtPriceX96FromReserves(r1.a, r1.u);
    const a1 = await bal(asset, deployer.address);
    const u1 = await bal(usdc,  deployer.address);

    // correctness
    expect(b0U - u1).to.equal(amountIn);
    expect(a1 >= b0A).to.equal(true);
    if (quoted > 0n) expect(a1 - b0A).to.equal(quoted);

    // Directional check (U->A → implied sqrt increases)
    expect(s1Implied >= s0Implied).to.equal(true);

    expect({
      role: "MCV",
      direction: "USDC->ASSET",
      amountIn: amountIn.toString(),
      poolQuote: quoted.toString(),
      sqrtPriceX96: {
        stored:  { before: s0Stored?.toString() ?? null, after: s1Stored?.toString() ?? null },
        implied: { before: s0Implied.toString(),         after:  s1Implied.toString() }
      },
      reserves: {
        before: { a: r0.a.toString(), u: r0.u.toString() },
        after:  { a: r1.a.toString(), u: r1.u.toString() },
      },
      caller: {
        before: { a: b0A.toString(), u: b0U.toString() },
        after:  { a: a1.toString(),  u: u1.toString()  },
      },
    }).to.matchSnapshot("MCV — sqrt+reserves U->A");
  });

  describe("Bypass guard via direct token movement (MCV path)", () => {
    it("ERC20.transfer / transferFrom to pool must NOT mutate reserves", async () => {
      const env = await deployCore();
      const { deployer, hook, pool } = env;

      // Seed
      await (await hook.mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("100"),
        amountUsdcDesired:  ethers.parseEther("100"),
        data: "0x",
      })).wait();

      const { asset, usdc } = await getTokensFromPool(pool);
      const poolAddr = await pool.getAddress();

      const r0 = await reserves(pool);

      const amt = ethers.parseEther("5");
      const twice = amt * 2n;

      await (await env.asset.connect(deployer).mint(deployer.address, twice)).wait();
      await (await env.usdc.connect(deployer).mint(deployer.address, twice)).wait();

      // (1) direct transfer
      await (await asset.connect(deployer).transfer(poolAddr, amt)).wait();
      await (await usdc.connect(deployer).transfer(poolAddr, amt)).wait();

      // (2) transferFrom (approve self then move)
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
        note: "Direct token moves cannot spoof LPP reserves (MCV path)",
      }).to.matchSnapshot("MCV — bypass-guard reserves unchanged");
    });
  });
});