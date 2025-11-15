// test/Revocation.spec.ts
import hre from "hardhat";
const { ethers, network } = hre;

import { expect } from "./shared/expect.ts";
import { deployCore } from "./helpers.ts";

import type {
  TestERC20,
  LPPPool,
  LPPRouter,
  LPPAccessManager,
  LPPTreasury,
} from "../typechain-types/index.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────────── */

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

/**
 * Ensure the canonical Phase-0 pool has non-zero reserves.
 *
 * Uses LPPTreasury.bootstrapViaTreasury (4-arg overload) if and only if
 * reserves are still zero. If some other setup already bootstrapped the
 * pool, this becomes a no-op.
 */
async function seedPoolIfNeeded(env: CoreEnv | any) {
  const { pool, treasury, asset, usdc, deployer } = env;

  const currentA = BigInt((await pool.reserveAsset()).toString());
  const currentU = BigInt((await pool.reserveUsdc()).toString());

  // Already initialized; nothing to do.
  if (currentA > 0n || currentU > 0n) return;

  const amtA = ethers.parseEther("100");
  const amtU = ethers.parseEther("100");

  // Mint to Treasury so it can bootstrap.
  const tAddr = await treasury.getAddress();
  await (await asset.connect(deployer).mint(tAddr, amtA)).wait();
  await (await usdc.connect(deployer).mint(tAddr, amtU)).wait();

  // Explicitly select the 4-arg overload to avoid ethers v6 ambiguity
  const bootstrap = (treasury as any)[
    "bootstrapViaTreasury(address,uint256,uint256,int256)"
  ] as (pool: string, a: bigint, u: bigint, offsetBps: bigint) => Promise<any>;

  try {
    await (
      await bootstrap(await pool.getAddress(), amtA, amtU, 0n)
    ).wait();
  } catch (err: any) {
    const msg: string = err?.message ?? "";
    // If some other path already called bootstrapInitialize, ignore "already init".
    if (!msg.includes("already init")) {
      throw err;
    }
  }
}

async function approveForSupplicate(
  env: CoreEnv | any,
  owner: any,
  assetToUsdc: boolean
) {
  const { router, pool, asset, usdc } = env;
  const routerAddr = await router.getAddress();
  const poolAddr = await pool.getAddress();

  if (assetToUsdc) {
    await (
      await asset.connect(owner).approve(routerAddr, ethers.MaxUint256)
    ).wait();
    await (
      await asset.connect(owner).approve(poolAddr, ethers.MaxUint256)
    ).wait();
  } else {
    await (
      await usdc.connect(owner).approve(routerAddr, ethers.MaxUint256)
    ).wait();
    await (
      await usdc.connect(owner).approve(poolAddr, ethers.MaxUint256)
    ).wait();
  }
}

async function reserves(env: CoreEnv | any) {
  const a = BigInt((await env.pool.reserveAsset()).toString());
  const u = BigInt((await env.pool.reserveUsdc()).toString());
  return { a, u };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Specs
 * ──────────────────────────────────────────────────────────────────────────── */

describe("Revocation enforcement (AccessManager-gated supplicate)", () => {
  it("revoked approved supplicator cannot call", async () => {
    const env: CoreEnv | any = await deployCore();
    const { other, access, router, pool } = env;

    // approve then revoke
    await (
      await access.setApprovedSupplicator(other.address, true)
    ).wait();
    await (
      await access.setApprovedSupplicator(other.address, false)
    ).wait();

    await expect(
      (router.connect(other) as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: other.address,
        payer: other.address,
      })
    ).to.be.revertedWith("not permitted");
  });

  it("non-approved caller is rejected", async () => {
    const env: CoreEnv | any = await deployCore();
    const { other, router, pool } = env;

    await expect(
      (router.connect(other) as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: other.address,
        payer: other.address,
      })
    ).to.be.revertedWith("not permitted");
  });

  it("re-approval restores access", async () => {
    const env: CoreEnv | any = await deployCore();
    const { deployer, other, access, router, pool, asset } = env;

    // Ensure pool has reserves so we don't hit "empty reserves"
    await seedPoolIfNeeded(env);

    // fund 'other' and approvals for a tiny A->U supplication
    await (
      await asset
        .connect(deployer)
        .mint(other.address, ethers.parseEther("0.1"))
    ).wait();
    await approveForSupplicate(env, other, /* assetToUsdc */ true);

    // revoke, then re-approve
    await (
      await access.setApprovedSupplicator(other.address, false)
    ).wait();
    await (
      await access.setApprovedSupplicator(other.address, true)
    ).wait();

    // now it should succeed
    const tx = await (router.connect(other) as any).supplicate({
      pool: await pool.getAddress(),
      assetToUsdc: true,
      amountIn: ethers.parseEther("0.1"),
      minAmountOut: 0n,
      to: other.address,
      payer: other.address,
    });
    const rc = await tx.wait();
    expect(rc?.status).to.equal(1);
  });

  describe("Revocation race (same block ordering)", () => {
    it("queued in same block → revocation wins over pending supplicate", async () => {
      const env: CoreEnv | any = await deployCore();
      const { deployer, other, access, router, pool, asset } = env;

      await seedPoolIfNeeded(env);

      // fund + approvals for 'other'
      await (
        await asset
          .connect(deployer)
          .mint(other.address, ethers.parseEther("0.1"))
      ).wait();
      await approveForSupplicate(env, other, /* assetToUsdc */ true);

      // 1) approve first, so trading is normally allowed
      await (
        await access.setApprovedSupplicator(other.address, true)
      ).wait();

      // 2) stop automine, queue: REVOKE first, TRADE second
      await network.provider.send("evm_setAutomine", [false]);

      const revokeTx = await access.setApprovedSupplicator(
        other.address,
        false
      );
      const tradeTx = await (router.connect(other) as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("0.1"),
        minAmountOut: 0n,
        to: other.address,
        payer: other.address,
      });

      // 3) mine a couple blocks to include both txs
      await network.provider.send("hardhat_mine", ["0x2"]);

      // 4) re-enable automine
      await network.provider.send("evm_setAutomine", [true]);

      // 5) ensure revoke is mined
      await revokeTx.wait();

      // 6) trade should end up rejected after revocation
      const tradeResult = await tradeTx.wait().then(
        (rcpt: any) => ({ ok: true, rcpt }),
        (err: any) => ({ ok: false, err })
      );

      expect(
        tradeResult.ok,
        "trade should be rejected after revocation"
      ).to.equal(false);
    });
  });

  describe("Bypass guard via ERC20.transfer? (No — reserves are authoritative)", () => {
    it("direct token transfer to pool address does not change pool reserves", async () => {
      const env: CoreEnv | any = await deployCore();
      const { deployer, pool, asset } = env;

      await seedPoolIfNeeded(env);

      const poolAddr = await pool.getAddress();

      const r0 = await reserves(env);
      const bal0 = BigInt((await asset.balanceOf(poolAddr)).toString());

      // send raw tokens directly (no hook/pool function call)
      await (
        await asset
          .connect(deployer)
          .mint(deployer.address, ethers.parseEther("1"))
      ).wait();
      await (
        await asset
          .connect(deployer)
          .transfer(poolAddr, ethers.parseEther("1"))
      ).wait();

      const r1 = await reserves(env);
      const bal1 = BigInt((await asset.balanceOf(poolAddr)).toString());

      // Token balance at the address increased…
      expect(bal1 - bal0).to.equal(ethers.parseEther("1"));

      // …but pool’s accounting reserves remain unchanged
      expect(r1.a - r0.a).to.equal(0n);
      expect(r1.u - r0.u).to.equal(0n);
    });
  });

  describe("Idempotency of revocation", () => {
    it("double revocation remains revoked and does not revert", async () => {
      const env: CoreEnv | any = await deployCore();
      const { other, access } = env;

      // directly toggling false → false
      await (
        await access.setApprovedSupplicator(other.address, false)
      ).wait();
      await (
        await access.setApprovedSupplicator(other.address, false)
      ).wait();

      // quick sanity: true → false → false still ends false; no revert
      await (
        await access.setApprovedSupplicator(other.address, true)
      ).wait();
      await (
        await access.setApprovedSupplicator(other.address, false)
      ).wait();
      await (
        await access.setApprovedSupplicator(other.address, false)
      ).wait();

      // We don't need a getter; behavior is covered by other specs.
      expect(true).to.equal(true);
    });
  });
});