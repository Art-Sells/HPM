import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import { deployCore } from "./helpers.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * Interfaces & constants
 * ──────────────────────────────────────────────────────────────────────────── */

const IERC20_FQN = "contracts/external/IERC20.sol:IERC20";

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
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

async function mintTo(
  env: { asset: any; usdc: any; deployer: any },
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
  // price = U/A; sqrt(price)*2^96 => sqrt( (U/A) * 2^192 ) = sqrt( (U<<192)/A )
  const NUM_SHIFTED = u << 192n;
  return isqrt(NUM_SHIFTED / a);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Spec
 * ──────────────────────────────────────────────────────────────────────────── */

describe("Supplicate (Approved)", () => {
  it("Treasury-approved address executes rebalance", async () => {
    const env = await deployCore();
    const { other, access, pool, router, hook, deployer } = env;

    // Seed pool so price/reserves exist (100/100)
    await (await hook.mintWithRebate({
      pool: await pool.getAddress(),
      to: deployer.address,
      amountAssetDesired: ethers.parseEther("100"),
      amountUsdcDesired:  ethers.parseEther("100"),
      data: "0x",
    })).wait();

    await (await access.setApprovedSupplicator(other.address, true)).wait();

    const amountIn = ethers.parseEther("1");
    const { asset, usdc } = await getTokensFromPool(pool);
    await mintTo(env, other.address, /*assetToUsdc*/ true, amountIn);
    await approveInputForSupplicate(asset, other, router, pool);

    // Before snapshots
    const r0 = await reserves(pool);
    const s0Stored = await safeReadSqrtPriceX96(pool);
    const s0Implied = impliedSqrtPriceX96FromReserves(r0.a, r0.u);

    const poolAddr = await pool.getAddress();
    const b0A = await bal(asset, other.address);
    const b0U = await bal(usdc,  other.address);

    const quoted = await getPoolQuotedAmountOut(pool, true, amountIn);

    // Static-call (optional)
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
    } catch {
      staticOut = null;
    }

    // Execute
    await expect((router.connect(other) as any).supplicate({
      pool: poolAddr,
      assetToUsdc: true,
      amountIn,
      minAmountOut: 0n,
      to: other.address,
      payer: other.address,
    })).not.to.be.reverted;

    // After snapshots
    const r1 = await reserves(pool);
    const s1Stored = await safeReadSqrtPriceX96(pool);
    const s1Implied = impliedSqrtPriceX96FromReserves(r1.a, r1.u);

    const a1 = await bal(asset, other.address);
    const u1 = await bal(usdc,  other.address);

    // Basic correctness
    expect(b0A - a1).to.equal(amountIn);     // spent asset
    expect(u1 >= b0U).to.equal(true);        // received USDC
    if (quoted > 0n)      expect(u1 - b0U).to.equal(quoted);
    if (staticOut !== null) expect(u1 - b0U).to.equal(staticOut!);

    // Reserve deltas correspond to user deltas
    const poolAOut = r0.a > r1.a ? r0.a - r1.a : 0n;
    const poolUOut = r0.u > r1.u ? r0.u - r1.u : 0n;
    const userAOut = a1 > b0A ? a1 - b0A : 0n;
    const userUOut = u1 > b0U ? u1 - b0U : 0n;
    expect(poolAOut).to.equal(userAOut);
    expect(poolUOut).to.equal(userUOut);

    // Directional price check (ASSET->USDC reduces U/A ⇒ implied sqrt decreases)
    expect(s1Implied <= s0Implied).to.equal(true);

    // Snapshot concise summary
    expect({
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
        stored: { before: s0Stored?.toString() ?? null, after: s1Stored?.toString() ?? null },
        implied: { before: s0Implied.toString(), after: s1Implied.toString() },
      }
    }).to.matchSnapshot("approved — first supplicate summary");
  });

  describe("Access control", () => {
    it("non-approved address cannot supplicate", async () => {
      const env = await deployCore();
      const { other, pool, router, hook, deployer } = env;

      await (await hook.mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("100"),
        amountUsdcDesired:  ethers.parseEther("100"),
        data: "0x",
      })).wait();

      const amountIn = ethers.parseEther("1");
      const { asset } = await getTokensFromPool(pool);
      await mintTo(env, other.address, true, amountIn);
      await approveInputForSupplicate(asset, other, router, pool);

      await expect((router.connect(other) as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn,
        minAmountOut: 0n,
        to: other.address,
        payer: other.address,
      })).to.be.revertedWith("not permitted");
    });
  });

  describe("Snapshots & sqrt pricing", () => {
    it("captures sqrtPriceX96 movement (if any) and reserve deltas for USDC->ASSET too", async () => {
      const env = await deployCore();
      const { other, access, pool, router, hook, deployer } = env;

      await (await hook.mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("100"),
        amountUsdcDesired:  ethers.parseEther("100"),
        data: "0x",
      })).wait();

      await (await access.setApprovedSupplicator(other.address, true)).wait();

      const amountIn = ethers.parseEther("1");
      const { asset, usdc } = await getTokensFromPool(pool);
      await mintTo(env, other.address, /*assetToUsdc*/ false, amountIn); // fund USDC
      await approveInputForSupplicate(usdc, other, router, pool);

      const r0 = await reserves(pool);
      const s0Stored  = await safeReadSqrtPriceX96(pool);
      const s0Implied = impliedSqrtPriceX96FromReserves(r0.a, r0.u);

      const b0A = await bal(asset, other.address);
      const b0U = await bal(usdc,  other.address);

      const quoted = await getPoolQuotedAmountOut(pool, /*assetToUsdc*/ false, amountIn);

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
      const u1 = await bal(usdc,  other.address);

      expect(b0U - u1).to.equal(amountIn);     // spent USDC
      expect(a1 >= b0A).to.equal(true);        // received asset
      if (quoted > 0n) expect(a1 - b0A).to.equal(quoted);

      // Directional price check (USDC->ASSET increases U/A ⇒ implied sqrt increases)
      expect(s1Implied >= s0Implied).to.equal(true);

      expect({
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
      }).to.matchSnapshot("approved — sqrt+reserves U->A");
    });
  });

  describe("Bypass guard via direct token movement (should fail to affect reserves)", () => {
    it("ERC20.transfer and transferFrom into pool address do NOT update pool reserves", async () => {
      const env = await deployCore();
      const { deployer, other, hook, pool } = env;

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

      await (await env.asset.connect(deployer).mint(other.address, twice)).wait();
      await (await env.usdc.connect(deployer).mint(other.address, twice)).wait();

      await (await asset.connect(other).transfer(poolAddr, amt)).wait();
      await (await usdc.connect(other).transfer(poolAddr, amt)).wait();

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