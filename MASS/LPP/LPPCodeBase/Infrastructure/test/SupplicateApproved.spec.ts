// test/SupplicateApproved.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import { deployCore } from "./helpers.ts";

import type {
  IERC20,
  TestERC20,
  LPPPool,
  LPPRouter,
  LPPAccessManager,
  LPPTreasury,
} from "../typechain-types/index.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * Interfaces & types
 * ──────────────────────────────────────────────────────────────────────────── */

const IERC20_FQN = "contracts/external/IERC20.sol:IERC20";

type CoreEnv = {
  deployer: any;
  other: any;
  router: LPPRouter;
  pool: LPPPool;
  asset: TestERC20;
  usdc: TestERC20;
  access: LPPAccessManager;
  treasury: LPPTreasury;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

async function getTokensFromPool(
  pool: LPPPool
): Promise<{ asset: IERC20; usdc: IERC20 }> {
  const assetAddr = await pool.asset();
  const usdcAddr  = await pool.usdc();
  const asset = (await ethers.getContractAt(IERC20_FQN, assetAddr)) as unknown as IERC20;
  const usdc  = (await ethers.getContractAt(IERC20_FQN, usdcAddr))  as unknown as IERC20;
  return { asset, usdc };
}

async function reserves(pool: LPPPool) {
  const a = BigInt((await pool.reserveAsset()).toString());
  const u = BigInt((await pool.reserveUsdc()).toString());
  return { a, u };
}

async function bal(token: IERC20, who: string) {
  return BigInt((await token.balanceOf(who)).toString());
}

async function approveInputForSupplicate(
  token: IERC20,
  payer: any,
  _router: LPPRouter,
  pool: LPPPool
) {
  // Fee-less supplicate: only the pool needs allowance
  await (await token.connect(payer).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
}

async function mintTo(
  env: { asset: TestERC20; usdc: TestERC20; deployer: any },
  to: string,
  assetToUsdc: boolean,
  amount: bigint
) {
  if (assetToUsdc) {
    await (await env.asset.connect(env.deployer).mint(to, amount)).wait();
  } else {
    await (await env.usdc.connect(env.deployer).mint(to, amount)).wait();
  }
}

/** Ensure the Phase-0 pool has 100/100 reserves (no-op if already set). */
async function seedPoolIfNeeded(env: CoreEnv | any) {
  const { pool, treasury, asset, usdc, deployer } = env;
  const currentA = BigInt((await pool.reserveAsset()).toString());
  const currentU = BigInt((await pool.reserveUsdc()).toString());
  if (currentA > 0n || currentU > 0n) return;

  const amtA = ethers.parseEther("100");
  const amtU = ethers.parseEther("100");
  const tAddr = await treasury.getAddress();

  await (await asset.connect(deployer).mint(tAddr, amtA)).wait();
  await (await usdc.connect(deployer).mint(tAddr, amtU)).wait();

  const bootstrap = (treasury as any)["bootstrapViaTreasury(address,uint256,uint256,int256)"] as
    (pool: string, a: bigint, u: bigint, offsetBps: bigint) => Promise<any>;

  try {
    await (await bootstrap(await pool.getAddress(), amtA, amtU, 0n)).wait();
  } catch (err: any) {
    const msg: string = err?.message ?? "";
    if (!msg.includes("already init")) throw err;
  }
}

/** Best-effort sqrt reader supporting multiple shapes (slot0, priceX96, etc.) */
async function safeReadSqrtPriceX96(pool: any): Promise<bigint | null> {
  const tryFns = ["sqrtPriceX96","getSqrtPriceX96","currentSqrtPriceX96","priceX96","slot0"];
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

/** Pool-naïve quote (no fees, no donations): x * rOut / (rIn + x) */
async function poolQuote(
  pool: LPPPool,
  assetToUsdc: boolean,
  amountIn: bigint
) {
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

/* ────────────────────────────────────────────────────────────────────────────
 * Spec
 * ──────────────────────────────────────────────────────────────────────────── */

describe("Supplicate (Approved-only flow)", () => {
  it("Treasury-approved address executes single-pool rebalance A->U", async () => {
    const env: CoreEnv | any = await deployCore();
    const { other, access, pool, router, deployer } = env;

    await seedPoolIfNeeded(env);
    await (await access.setApprovedSupplicator(other.address, true)).wait();

    const amountIn = ethers.parseEther("1");
    const { asset, usdc } = await getTokensFromPool(pool);

    await mintTo(env, other.address, /* A->U */ true, amountIn);
    await approveInputForSupplicate(asset, other, router, pool);

    // Before
    const r0 = await reserves(pool);
    const s0Stored  = await safeReadSqrtPriceX96(pool);
    const s0Implied = impliedSqrtPriceX96FromReserves(r0.a, r0.u);
    const poolAddr = await pool.getAddress();
    const b0A = await bal(asset, other.address);
    const b0U = await bal(usdc, other.address);

    const quoted = await poolQuote(pool, true, amountIn);

    // router static (should match naïve now that fees are 0)
    let staticOut: bigint | null = null;
    try {
      staticOut = await (router.connect(other) as any).supplicate.staticCall({
        pool: poolAddr,
        assetToUsdc: true,
        amountIn,
        minAmountOut: 0n,
        to: other.address,
        payer: other.address,
      });
    } catch { staticOut = null; }

    await expect(
      (router.connect(other) as any).supplicate({
        pool: poolAddr,
        assetToUsdc: true,
        amountIn,
        minAmountOut: 0n,
        to: other.address,
        payer: other.address,
      })
    ).not.to.be.reverted;

    const r1 = await reserves(pool);
    const s1Stored  = await safeReadSqrtPriceX96(pool);
    const s1Implied = impliedSqrtPriceX96FromReserves(r1.a, r1.u);
    const a1 = await bal(asset, other.address);
    const u1 = await bal(usdc, other.address);

    // Spent = amountIn exactly (no fee)
    expect(b0A - a1).to.equal(amountIn);

    // Received equals pool quote (and static, if present)
    const userUsdcOut = u1 - b0U;
    expect(userUsdcOut).to.equal(quoted);
    if (staticOut !== null) expect(userUsdcOut).to.equal(staticOut!);

    // Reserves mirror user deltas
    const poolUOut = r0.u > r1.u ? r0.u - r1.u : 0n;
    expect(poolUOut).to.equal(userUsdcOut);

    // Price direction: A->U reduces U/A ⇒ implied sqrt decreases
    expect(s1Implied <= s0Implied).to.equal(true);

    expect({
      direction: "ASSET->USDC",
      amountIn: amountIn.toString(),
      quote: quoted.toString(),
      routerStatic: staticOut?.toString() ?? null,
      reserves: {
        before: { a: r0.a.toString(), u: r0.u.toString() },
        after:  { a: r1.a.toString(), u: r1.u.toString() },
      },
      callerBalances: {
        before: { a: b0A.toString(), u: b0U.toString() },
        after:  { a: a1.toString(), u: u1.toString() },
      },
      sqrtPriceX96: {
        stored:  { before: s0Stored?.toString() ?? null, after: s1Stored?.toString() ?? null },
        implied: { before: s0Implied.toString(),          after: s1Implied.toString() },
      },
    }).to.matchSnapshot("approved — first supplicate summary A->U");
  });

  describe("Access control (Approved-only)", () => {
    it("non-approved address cannot supplicate", async () => {
      const env: CoreEnv | any = await deployCore();
      const { other, pool, router } = env;

      await seedPoolIfNeeded(env);

      const amountIn = ethers.parseEther("1");
      const { asset } = await getTokensFromPool(pool);
      await mintTo(env, other.address, true, amountIn);
      await approveInputForSupplicate(asset, other, router, pool);

      await expect(
        (router.connect(other) as any).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn,
          minAmountOut: 0n,
          to: other.address,
          payer: other.address,
        })
      ).to.be.revertedWith("not permitted");
    });
  });

  describe("Snapshots & sqrt pricing (U->A path)", () => {
    it("captures sqrtPriceX96 movement and reserve deltas for USDC->ASSET", async () => {
      const env: CoreEnv | any = await deployCore();
      const { other, access, pool, router } = env;

      await seedPoolIfNeeded(env);
      await (await access.setApprovedSupplicator(other.address, true)).wait();

      const amountIn = ethers.parseEther("1");
      const { asset, usdc } = await getTokensFromPool(pool);

      await mintTo(env, other.address, /* U->A */ false, amountIn);
      await approveInputForSupplicate(usdc, other, router, pool);

      const r0 = await reserves(pool);
      const s0Stored  = await safeReadSqrtPriceX96(pool);
      const s0Implied = impliedSqrtPriceX96FromReserves(r0.a, r0.u);
      const b0A = await bal(asset, other.address);
      const b0U = await bal(usdc, other.address);

      const quoted = await poolQuote(pool, false, amountIn);

      await (router.connect(other) as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: false,
        amountIn,
        minAmountOut: 0n,
        to: other.address,
        payer: other.address,
      });

      const r1 = await reserves(pool);
      const s1Stored  = await safeReadSqrtPriceX96(pool);
      const s1Implied = impliedSqrtPriceX96FromReserves(r1.a, r1.u);
      const a1 = await bal(asset, other.address);
      const u1 = await bal(usdc, other.address);

      expect(b0U - u1).to.equal(amountIn);       // spent USDC (no fee)
      expect(a1 - b0A).to.equal(quoted);         // received ASSET

      // U->A increases U/A ⇒ implied sqrt increases
      expect(s1Implied >= s0Implied).to.equal(true);

      expect({
        direction: "USDC->ASSET",
        amountIn: amountIn.toString(),
        quote: quoted.toString(),
        sqrtPriceX96: {
          stored:  { before: s0Stored?.toString() ?? null, after: s1Stored?.toString() ?? null },
          implied: { before: s0Implied.toString(),          after: s1Implied.toString() },
        },
        reserves: {
          before: { a: r0.a.toString(), u: r0.u.toString() },
          after:  { a: r1.a.toString(), u: r1.u.toString() },
        },
        caller: {
          before: { a: b0A.toString(), u: b0U.toString() },
          after:  { a: a1.toString(),  u: u1.toString()  },
        },
      }).to.matchSnapshot("approved — sqrt+reserves U->A");
    });
  });

  describe("Bypass guard via direct token movement (reserves authoritative)", () => {
    it("ERC20.transfer and transferFrom into pool address do NOT update pool reserves", async () => {
      const env: CoreEnv | any = await deployCore();
      const { deployer, other, pool } = env;

      await seedPoolIfNeeded(env);

      const { asset, usdc } = await getTokensFromPool(pool);
      const poolAddr = await pool.getAddress();

      const r0 = await reserves(pool);

      const amt = ethers.parseEther("5");
      const twice = amt * 2n;

      await (await env.asset.connect(deployer).mint(other.address, twice)).wait();
      await (await env.usdc.connect(deployer).mint(other.address, twice)).wait();

      // direct transfers
      await (await asset.connect(other).transfer(poolAddr, amt)).wait();
      await (await usdc.connect(other).transfer(poolAddr, amt)).wait();

      // transferFrom into pool
      await (await env.asset.connect(other).approve(deployer.address, amt)).wait();
      await (await env.usdc.connect(other).approve(deployer.address, amt)).wait();
      await (await asset.connect(deployer).transferFrom(other.address, poolAddr, amt)).wait();
      await (await usdc.connect(deployer).transferFrom(other.address, poolAddr, amt)).wait();

      const r1 = await reserves(pool);
      expect(r1.a).to.equal(r0.a);
      expect(r1.u).to.equal(r0.u);

      expect({
        reservesBefore: { a: r0.a.toString(), u: r0.u.toString() },
        reservesAfter:  { a: r1.a.toString(), u: r1.u.toString() },
        note: "Raw token transfers cannot spoof/mutate LPP reserves",
      }).to.matchSnapshot("bypass-guard — reserves unchanged");
    });
  });
});