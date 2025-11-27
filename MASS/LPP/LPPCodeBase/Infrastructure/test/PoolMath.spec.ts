// test/PoolMath.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import { deployCore } from "./helpers.ts";

import type {
  TestERC20,
  LPPPool,
  LPPRouter,
  LPPTreasury,
  LPPAccessManager,
} from "../typechain-types";

/* ---------------- helpers ---------------- */

async function getTokens(env: any): Promise<{ asset: TestERC20; usdc: TestERC20 }> {
  return { asset: env.asset as TestERC20, usdc: env.usdc as TestERC20 };
}

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

/** router per-hop fee split for a given amountIn */
async function feeSplit(router: LPPRouter, amountIn: bigint) {
  const bps = BigInt(await router.BPS_DENOMINATOR());
  const feeBps = BigInt(await router.MCV_FEE_BPS());
  // TREASURY_CUT_BPS isn't in the interface but exists on the concrete contract
  const treasBps = BigInt(await (router as any).TREASURY_CUT_BPS());
  const total = (amountIn * feeBps) / bps;
  const treasury = (amountIn * treasBps) / bps;
  const pools = total - treasury;
  return { total, treasury, pools };
}

/** balanceOf helper */
async function bal(token: TestERC20, who: string): Promise<bigint> {
  return BigInt((await token.balanceOf(who)).toString());
}

/** Mint tokens to Treasury, then bootstrap the pool via Treasury (Phase 0 style). */
async function bootstrapSeed(
  treasury: LPPTreasury,
  pool: LPPPool,
  asset: TestERC20,
  usdc: TestERC20,
  deployer: any,
  amountAsset: bigint,
  amountUsdc: bigint,
  offsetBps: bigint = 0n
) {
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
    pool: string,
    amountAsset: bigint,
    amountUsdc: bigint,
    offsetBps: bigint
  ) => Promise<any>;

  await fn4(await pool.getAddress(), amountAsset, amountUsdc, offsetBps);
}

/** POOL does transferFrom(...) inside LPPPool.supplicate → approve the POOL (and optionally Router) */
async function fundAndApproveForSupplicate(opts: {
  token: TestERC20;
  minter: any; // deployer (has mint perms in TestERC20)
  payer: any;
  pool: LPPPool;
  router?: LPPRouter; // optional
  amount: bigint;
}) {
  const { token, minter, payer, pool, router, amount } = opts;
  const payerAddr = await payer.getAddress();
  await (await token.connect(minter).mint(payerAddr, amount)).wait();
  await (await token.connect(payer).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
  if (router) {
    await (await token.connect(payer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
  }
}

/* ---------------- tests ---------------- */

describe("Pool math integrity", () => {
  describe("Reserves update on mint/supplicate", () => {
    it("reserves move in correct directions for ASSET->USDC", async () => {
      const env: any = await deployCore();
      const { deployer, pool, router, treasury, access } = env;
      const { asset, usdc } = await getTokens(env);

      // allow deployer to supplicate
      await (await (access as LPPAccessManager).setApprovedSupplicator(deployer.address, true)).wait();

      // before bootstrap: zero reserves
      const beforeA = await pool.reserveAsset();
      const beforeU = await pool.reserveUsdc();
      expect(beforeA).to.equal(0n);
      expect(beforeU).to.equal(0n);

      // seed pool via Treasury: 5 ASSET + 5 USDC
      await bootstrapSeed(
        treasury as LPPTreasury,
        pool as LPPPool,
        asset,
        usdc,
        deployer,
        ethers.parseEther("5"),
        ethers.parseEther("5"),
      );

      const midA = await pool.reserveAsset();
      const midU = await pool.reserveUsdc();
      expect(midA).to.be.gt(beforeA);
      expect(midU).to.be.gt(beforeU);

      // fund payer with ASSET and approve POOL+Router
      await fundAndApproveForSupplicate({
        token: asset,
        minter: deployer,
        payer: deployer,
        pool,
        router,
        amount: ethers.parseEther("2"),
      });

      const args = {
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      };

      await (router.connect(deployer) as any).supplicate(args);

      const afterA = await pool.reserveAsset();
      const afterU = await pool.reserveUsdc();

      // pool gains ASSET (from payer + poolsFee), loses USDC (to payer)
      expect(afterA).to.be.gt(midA);
      expect(afterU).to.be.lt(midU);
    });
  });

  describe("Directional accounting", () => {
    it("ASSET->USDC: conservation holds without fees", async () => {
      const env: any = await deployCore();
      const { deployer, pool, router, treasury, access } = env;
      const { asset, usdc } = await getTokens(env);

      await (await (access as LPPAccessManager).setApprovedSupplicator(deployer.address, true)).wait();

      // seed pool with 10/10
      await bootstrapSeed(
        treasury as LPPTreasury,
        pool as LPPPool,
        asset,
        usdc,
        deployer,
        ethers.parseEther("10"),
        ethers.parseEther("10"),
      );

      // fund + approve ASSET to POOL + Router
      await fundAndApproveForSupplicate({
        token: asset,
        minter: deployer,
        payer: deployer,
        pool,
        router,
        amount: ethers.parseEther("2"),
      });

      const who = deployer.address;
      const routerAddr = await router.getAddress();
      const treasuryAddr = await treasury.getAddress();

      const bA0 = await bal(asset, who);
      const bU0 = await bal(usdc, who);
      const r0 = await reserves(pool);
      const tA0 = await bal(asset, treasuryAddr);
      const roA0 = await bal(asset, routerAddr);

      const args = {
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: who,
        payer: who,
      };

      const quoted: bigint = await (router.connect(deployer) as any).supplicate.staticCall(args);
      await (router.connect(deployer) as any).supplicate(args);

      const bA1 = await bal(asset, who);
      const bU1 = await bal(usdc, who);
      const r1 = await reserves(pool);
      const tA1 = await bal(asset, treasuryAddr);
      const roA1 = await bal(asset, routerAddr);

      // user spent ASSET: amountIn
      expect(bA0 - bA1).to.equal(args.amountIn);
      // user received USDC: quoted
      expect(bU1 - bU0).to.equal(quoted);

      // pool gained ASSET = amountIn; lost USDC = quoted
      expect(r1.a - r0.a).to.equal(args.amountIn);
      expect(r0.u - r1.u).to.equal(quoted);

      // treasury unchanged
      expect(tA1 - tA0).to.equal(0n);

      // router shouldn't retain ASSET after fee split (donated+forwarded)
      expect(roA1).to.equal(roA0);

      // conservation (ASSET side): user + pool + treasury + router
      const sumA0 = bA0 + r0.a + tA0 + roA0;
      const sumA1 = bA1 + r1.a + tA1 + roA1;
      expect(sumA1).to.equal(sumA0);

      // conservation (USDC side): user + pool (router/treasury unaffected on USDC here)
      const sumU0 = bU0 + r0.u;
      const sumU1 = bU1 + r1.u;
      expect(sumU1).to.equal(sumU0);
    });

    it("USDC->ASSET: conservation holds without fees", async () => {
      const env: any = await deployCore();
      const { deployer, pool, router, treasury, access } = env;
      const { asset, usdc } = await getTokens(env);

      await (await (access as LPPAccessManager).setApprovedSupplicator(deployer.address, true)).wait();

      // seed pool with 10/10
      await bootstrapSeed(
        treasury as LPPTreasury,
        pool as LPPPool,
        asset,
        usdc,
        deployer,
        ethers.parseEther("10"),
        ethers.parseEther("10"),
      );

      // fund + approve USDC to POOL + Router
      await fundAndApproveForSupplicate({
        token: usdc,
        minter: deployer,
        payer: deployer,
        pool,
        router,
        amount: ethers.parseEther("2"),
      });

      const who = deployer.address;
      const routerAddr = await router.getAddress();
      const treasuryAddr = await treasury.getAddress();

      const bA0 = await bal(asset, who);
      const bU0 = await bal(usdc, who);
      const r0 = await reserves(pool);
      const tU0 = await bal(usdc, treasuryAddr);
      const roU0 = await bal(usdc, routerAddr);

      const args = {
        pool: await pool.getAddress(),
        assetToUsdc: false,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: who,
        payer: who,
      };

      const quoted: bigint = await (router.connect(deployer) as any).supplicate.staticCall(args);
      await (router.connect(deployer) as any).supplicate(args);

      const bA1 = await bal(asset, who);
      const bU1 = await bal(usdc, who);
      const r1 = await reserves(pool);
      const tU1 = await bal(usdc, treasuryAddr);
      const roU1 = await bal(usdc, routerAddr);

      // user spent USDC: amountIn
      expect(bU0 - bU1).to.equal(args.amountIn);
      // user received ASSET: quoted
      expect(bA1 - bA0).to.equal(quoted);

      // pool gained USDC = amountIn; lost ASSET = quoted
      expect(r1.u - r0.u).to.equal(args.amountIn);
      expect(r0.a - r1.a).to.equal(quoted);

      // treasury unchanged
      expect(tU1 - tU0).to.equal(0n);

      // router shouldn't retain USDC after fee split
      expect(roU1).to.equal(roU0);

      // conservation (USDC side): user + pool + treasury + router
      const sumU0c = bU0 + r0.u + tU0 + roU0;
      const sumU1c = bU1 + r1.u + tU1 + roU1;
      expect(sumU1c).to.equal(sumU0c);

      // conservation (ASSET side): user + pool
      const sumAc0 = bA0 + r0.a;
      const sumAc1 = bA1 + r1.a;
      expect(sumAc1).to.equal(sumAc0);
    });
  });

  describe("Validation & slippage", () => {
    it("reverts on empty reserves (supplicate before bootstrap)", async () => {
      // Use the already-deployed TestERC20 pool from deployCore, which is NOT bootstrapped yet.
      const env: any = await deployCore();
      const { deployer, router, pool, access } = env;
      const { asset } = await getTokens(env);

      await (await (access as LPPAccessManager).setApprovedSupplicator(deployer.address, true)).wait();

      // To reach the pool's "empty reserves" require, let router successfully take fee first.
      // -> mint payer some ASSET and approve the ROUTER (NOT the POOL).
      const feeProbeIn = ethers.parseEther("1"); // amountIn used below
      await (await asset.mint(deployer.address, feeProbeIn)).wait();
      await (await asset.connect(deployer).approve(await router.getAddress(), ethers.MaxUint256)).wait();

      await expect(
        (router.connect(deployer) as any).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: feeProbeIn,
          minAmountOut: 0n,
          to: deployer.address,
          payer: deployer.address,
        })
      ).to.be.revertedWith("empty reserves");
    });

    it("reverts when minAmountOut too high (slippage)", async () => {
      const env: any = await deployCore();
      const { deployer, pool, router, treasury, access } = env;
      const { asset, usdc } = await getTokens(env);

      await (await (access as LPPAccessManager).setApprovedSupplicator(deployer.address, true)).wait();

      // seed pool with 5/5
      await bootstrapSeed(
        treasury as LPPTreasury,
        pool as LPPPool,
        asset,
        usdc,
        deployer,
        ethers.parseEther("5"),
        ethers.parseEther("5"),
      );

      // fund + approve ASSET to POOL + Router
      await fundAndApproveForSupplicate({
        token: asset,
        minter: deployer,
        payer: deployer,
        pool,
        router,
        amount: ethers.parseEther("2"),
      });

      const baseArgs = {
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      };

      const quote: bigint = await (router.connect(deployer) as any).supplicate.staticCall(baseArgs);

      await expect(
        (router.connect(deployer) as any).supplicate({
          ...baseArgs,
          minAmountOut: quote + 1n,
        })
      ).to.be.revertedWith("slippage");
    });

    it("reverts on zero amountIn", async () => {
      const env: any = await deployCore();
      const { deployer, router, pool, access } = env;

      await (await (access as LPPAccessManager).setApprovedSupplicator(deployer.address, true)).wait();

      await expect(
        (router.connect(deployer) as any).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: 0n,
          minAmountOut: 0n,
          to: deployer.address,
          payer: deployer.address,
        })
      ).to.be.reverted; // "zero" from LPPPool (modifier)
    });
  });

  describe("Quote behavior (monotonicity & rounding)", () => {
    it("larger amountIn yields >= amountOut (same direction, same block)", async () => {
      const env: any = await deployCore();
      const { deployer, pool, router, treasury, access } = env;
      const { asset, usdc } = await getTokens(env);

      await (await (access as LPPAccessManager).setApprovedSupplicator(deployer.address, true)).wait();

      await bootstrapSeed(
        treasury as LPPTreasury,
        pool as LPPPool,
        asset,
        usdc,
        deployer,
        ethers.parseEther("20"),
        ethers.parseEther("20"),
      );

      await fundAndApproveForSupplicate({
        token: asset,
        minter: deployer,
        payer: deployer,
        pool,
        router,
        amount: ethers.parseEther("10"),
      });

      const argsSmall = {
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("0.2"),
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      };
      const argsBig = { ...argsSmall, amountIn: ethers.parseEther("0.4") };

      const outSmall: bigint = await (router.connect(deployer) as any).supplicate.staticCall(argsSmall);
      const outBig: bigint = await (router.connect(deployer) as any).supplicate.staticCall(argsBig);

      expect(outBig).to.be.gte(outSmall);
    });

    it("tiny trade produces non-zero output (if reserves are healthy)", async () => {
      const env: any = await deployCore();
      const { deployer, pool, router, treasury, access } = env;
      const { asset, usdc } = await getTokens(env);

      await (await (access as LPPAccessManager).setApprovedSupplicator(deployer.address, true)).wait();

      await bootstrapSeed(
        treasury as LPPTreasury,
        pool as LPPPool,
        asset,
        usdc,
        deployer,
        ethers.parseEther("50"),
        ethers.parseEther("50"),
      );

      await fundAndApproveForSupplicate({
        token: asset,
        minter: deployer,
        payer: deployer,
        pool,
        router,
        amount: ethers.parseEther("1"),
      });

      const argsTiny = {
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("0.0000000000000005"), // 5e-16
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      };

      const quoted: bigint = await (router.connect(deployer) as any).supplicate.staticCall(argsTiny);
      expect(quoted).to.be.gt(0n);
    });
  });

  describe("Round-trip sanity (tiny ASSET->USDC then back)", () => {
    it("small forward+reverse returns close to start (within expected loss)", async () => {
      const env: any = await deployCore();
      const { deployer, pool, router, treasury, access } = env;
      const { asset, usdc } = await getTokens(env);

      await (await (access as LPPAccessManager).setApprovedSupplicator(deployer.address, true)).wait();

      await bootstrapSeed(
        treasury as LPPTreasury,
        pool as LPPPool,
        asset,
        usdc,
        deployer,
        ethers.parseEther("40"),
        ethers.parseEther("40"),
      );

      // forward: need ASSET minted + approved to POOL + Router
      await fundAndApproveForSupplicate({
        token: asset,
        minter: deployer,
        payer: deployer,
        pool,
        router,
        amount: ethers.parseEther("1"),
      });

      const who = deployer.address;
      const a0 = await bal(asset, who);

      const fwdArgs = {
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("0.2"),
        minAmountOut: 0n,
        to: who,
        payer: who,
      };
      const fwdOut: bigint = await (router.connect(deployer) as any).supplicate.staticCall(fwdArgs);
      await (router.connect(deployer) as any).supplicate(fwdArgs);

      // reverse: approve POOL & Router for received USDC
      await (await usdc.connect(deployer).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
      await (await usdc.connect(deployer).approve(await router.getAddress(), ethers.MaxUint256)).wait();

      const revArgs = {
        pool: await pool.getAddress(),
        assetToUsdc: false,
        amountIn: fwdOut,
        minAmountOut: 0n,
        to: who,
        payer: who,
      };
      const revOut: bigint = await (router.connect(deployer) as any).supplicate.staticCall(revArgs);
      await (router.connect(deployer) as any).supplicate(revArgs);

      const a1 = await bal(asset, who);

      // forward spent 0.2 ASSET + fee, reverse recovered some;
      // we keep the same “small loss” envelope as before
      const spent = ethers.parseEther("0.2");
      const netLoss = (a0 - a1) - (spent - revOut);

      expect(netLoss).to.be.gte(0n);
      const fiftyBps = (spent * 50n) / 10_000n;
      expect(netLoss).to.be.lte(fiftyBps);
    });
  });

  describe("Offset multiplier behavior", () => {
    async function setupPool(offset: number) {
      const env: any = await deployCore();
      const { deployer, pool, router, treasury, access } = env;
      const tokens = await getTokens(env);
      await (await (access as LPPAccessManager).setApprovedSupplicator(deployer.address, true)).wait();
      await bootstrapSeed(
        treasury as LPPTreasury,
        pool as LPPPool,
        tokens.asset,
        tokens.usdc,
        deployer,
        ethers.parseEther("1"),
        ethers.parseEther("1"),
        BigInt(offset)
      );
      return { deployer, pool, router, ...tokens };
    }

    it("USDC->ASSET with -5000 bps returns 50% premium", async () => {
      const { deployer, pool, router, usdc } = await setupPool(-5000);
      const amountIn = ethers.parseEther("0.01");
      await fundAndApproveForSupplicate({ token: usdc, minter: deployer, payer: deployer, pool, amount: amountIn });
      const quoted: bigint = await (router.connect(deployer) as any).supplicate.staticCall({
        pool: await pool.getAddress(),
        assetToUsdc: false,
        amountIn,
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      });
      const { a: reserveAsset, u: reserveUsdc } = await reserves(pool as LPPPool);
      const baseOut = (amountIn * reserveAsset) / reserveUsdc;
      const expected = (baseOut * 15000n) / 10000n;
      expect(quoted).to.equal(expected);
      expect({
        label: "offset -5000 usdc->asset",
        offsetBps: -5000,
        direction: "USDC->ASSET",
        amountIn: amountIn.toString(),
        reserveAsset: reserveAsset.toString(),
        reserveUsdc: reserveUsdc.toString(),
        baseOut: baseOut.toString(),
        expected: expected.toString(),
        quoted: quoted.toString(),
      }).to.matchSnapshot("offset -5000 usdc->asset");
    });

    it("ASSET->USDC with -5000 bps returns 50% discount", async () => {
      const { deployer, pool, router, asset } = await setupPool(-5000);
      const amountIn = ethers.parseEther("0.01");
      await fundAndApproveForSupplicate({ token: asset, minter: deployer, payer: deployer, pool, router, amount: amountIn });
      const quoted: bigint = await (router.connect(deployer) as any).supplicate.staticCall({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn,
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      });
      const { a: reserveAsset, u: reserveUsdc } = await reserves(pool as LPPPool);
      const baseOut = (amountIn * reserveUsdc) / reserveAsset;
      const expected = (baseOut * 5000n) / 10000n;
      expect(quoted).to.equal(expected);
      expect({
        label: "offset -5000 asset->usdc",
        offsetBps: -5000,
        direction: "ASSET->USDC",
        amountIn: amountIn.toString(),
        reserveAsset: reserveAsset.toString(),
        reserveUsdc: reserveUsdc.toString(),
        baseOut: baseOut.toString(),
        expected: expected.toString(),
        quoted: quoted.toString(),
      }).to.matchSnapshot("offset -5000 asset->usdc");
    });

    it("USDC->ASSET with +5000 bps returns 50% discount", async () => {
      const { deployer, pool, router, usdc } = await setupPool(5000);
      const amountIn = ethers.parseEther("0.01");
      await fundAndApproveForSupplicate({ token: usdc, minter: deployer, payer: deployer, pool, amount: amountIn });
      const quoted: bigint = await (router.connect(deployer) as any).supplicate.staticCall({
        pool: await pool.getAddress(),
        assetToUsdc: false,
        amountIn,
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      });
      const { a: reserveAsset, u: reserveUsdc } = await reserves(pool as LPPPool);
      const baseOut = (amountIn * reserveAsset) / reserveUsdc;
      const expected = (baseOut * 5000n) / 10000n;
      expect(quoted).to.equal(expected);
      expect({
        label: "offset +5000 usdc->asset",
        offsetBps: 5000,
        direction: "USDC->ASSET",
        amountIn: amountIn.toString(),
        reserveAsset: reserveAsset.toString(),
        reserveUsdc: reserveUsdc.toString(),
        baseOut: baseOut.toString(),
        expected: expected.toString(),
        quoted: quoted.toString(),
      }).to.matchSnapshot("offset +5000 usdc->asset");
    });

    it("ASSET->USDC with +5000 bps returns 50% premium", async () => {
      const { deployer, pool, router, asset } = await setupPool(5000);
      const amountIn = ethers.parseEther("0.01");
      await fundAndApproveForSupplicate({ token: asset, minter: deployer, payer: deployer, pool, router, amount: amountIn });
      const quoted: bigint = await (router.connect(deployer) as any).supplicate.staticCall({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn,
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      });
      const { a: reserveAsset, u: reserveUsdc } = await reserves(pool as LPPPool);
      const baseOut = (amountIn * reserveUsdc) / reserveAsset;
      const expected = (baseOut * 15000n) / 10000n;
      expect(quoted).to.equal(expected);
      expect({
        label: "offset +5000 asset->usdc",
        offsetBps: 5000,
        direction: "ASSET->USDC",
        amountIn: amountIn.toString(),
        reserveAsset: reserveAsset.toString(),
        reserveUsdc: reserveUsdc.toString(),
        baseOut: baseOut.toString(),
        expected: expected.toString(),
        quoted: quoted.toString(),
      }).to.matchSnapshot("offset +5000 asset->usdc");
    });
  });
});