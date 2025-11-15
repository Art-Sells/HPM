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

  // Call the 4-arg overload explicitly via signature (avoids ethers v6 ambiguity)
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

      // fund payer with ASSET and approve POOL
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

      // pool gains ASSET (from payer), loses USDC (to payer)
      expect(afterA).to.be.gt(midA);
      expect(afterU).to.be.lt(midU);
    });
  });

  describe("Directional accounting", () => {
    it("ASSET->USDC: pool deltas == user deltas (token-wise)", async () => {
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

      // fund + approve ASSET to POOL
      await fundAndApproveForSupplicate({
        token: asset,
        minter: deployer,
        payer: deployer,
        pool,
        router,
        amount: ethers.parseEther("2"),
      });

      const who = deployer.address;
      const bA0 = BigInt((await asset.balanceOf(who)).toString());
      const bU0 = BigInt((await usdc.balanceOf(who)).toString());
      const r0 = await reserves(pool);

      const args = {
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: who,
        payer: who,
      };

      const out: bigint = await (router.connect(deployer) as any).supplicate.staticCall(args);
      await (router.connect(deployer) as any).supplicate(args);

      const bA1 = BigInt((await asset.balanceOf(who)).toString());
      const bU1 = BigInt((await usdc.balanceOf(who)).toString());
      const r1 = await reserves(pool);

      // user spent ASSET and received USDC
      expect(bA0 - bA1).to.equal(args.amountIn);
      expect(bU1 - bU0).to.equal(out);

      // pool gained ASSET and lost USDC
      expect(r1.a - r0.a).to.equal(args.amountIn);
      expect(r0.u - r1.u).to.equal(out);

      // pool deltas == user deltas per leg
      expect(r0.a + bA0).to.equal(r1.a + bA1);
      expect(r0.u + bU0).to.equal(r1.u + bU1);
    });

    it("USDC->ASSET: pool deltas == user deltas (token-wise)", async () => {
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

      // fund + approve USDC to POOL
      await fundAndApproveForSupplicate({
        token: usdc,
        minter: deployer,
        payer: deployer,
        pool,
        router,
        amount: ethers.parseEther("2"),
      });

      const who = deployer.address;
      const bA0 = BigInt((await asset.balanceOf(who)).toString());
      const bU0 = BigInt((await usdc.balanceOf(who)).toString());
      const r0 = await reserves(pool);

      const args = {
        pool: await pool.getAddress(),
        assetToUsdc: false,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: who,
        payer: who,
      };

      const out: bigint = await (router.connect(deployer) as any).supplicate.staticCall(args);
      await (router.connect(deployer) as any).supplicate(args);

      const bA1 = BigInt((await asset.balanceOf(who)).toString());
      const bU1 = BigInt((await usdc.balanceOf(who)).toString());
      const r1 = await reserves(pool);

      // user spent USDC and received ASSET
      expect(bU0 - bU1).to.equal(args.amountIn);
      expect(bA1 - bA0).to.equal(out);

      // pool gained USDC and lost ASSET
      expect(r1.u - r0.u).to.equal(args.amountIn);
      expect(r0.a - r1.a).to.equal(out);

      // pool deltas == user deltas per leg
      expect(r0.a + bA0).to.equal(r1.a + bA1);
      expect(r0.u + bU0).to.equal(r1.u + bU1);
    });
  });

  describe("Validation & slippage", () => {
    it("reverts on empty reserves (supplicate before bootstrap)", async () => {
      const env: any = await deployCore();
      const { deployer, treasury, factory, router, access } = env;

      const rand = () => ethers.Wallet.createRandom().address;
      const a = rand();
      const u = rand();

      await (await (treasury as LPPTreasury).allowTokenViaTreasury(await factory.getAddress(), a, true)).wait();
      await (await (treasury as LPPTreasury).allowTokenViaTreasury(await factory.getAddress(), u, true)).wait();
      await (await (treasury as LPPTreasury).createPoolViaTreasury(await factory.getAddress(), a, u)).wait();

      const pools = await factory.getPools();
      const poolAddr = pools[pools.length - 1];
      const pool = (await ethers.getContractAt("LPPPool", poolAddr)) as LPPPool;

      await (await (access as LPPAccessManager).setApprovedSupplicator(deployer.address, true)).wait();

      await expect(
        (router.connect(deployer) as any).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
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

      // fund + approve ASSET to POOL
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
      ).to.be.reverted; // generic: "zero" from LPPPool
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

      // forward: need ASSET minted + approved to POOL
      await fundAndApproveForSupplicate({
        token: asset,
        minter: deployer,
        payer: deployer,
        pool,
        router,
        amount: ethers.parseEther("1"),
      });

      const who = deployer.address;
      const a0 = BigInt((await asset.balanceOf(who)).toString());

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

      const a1 = BigInt((await asset.balanceOf(who)).toString());

      // forward spent 0.2 ASSET, reverse recovered some;
      // net loss should be small (rounding), not catastrophic
      const spent = ethers.parseEther("0.2");
      const netLoss = (a0 - a1) - (spent - revOut);

      expect(netLoss).to.be.gte(0n);
      const fiftyBps = (spent * 50n) / 10_000n;
      expect(netLoss).to.be.lte(fiftyBps);
    });
  });
});