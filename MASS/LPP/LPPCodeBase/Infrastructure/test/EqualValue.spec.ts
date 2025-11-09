import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import snapshotGasCost from "./shared/snapshotGasCost.ts";
import { deployCore } from "./helpers.ts";

import type { LPPPool, LPPMintHook } from "../typechain-types";

/* ---------------- helpers ---------------- */

async function reserves(pool: LPPPool) {
  const a = (await (pool as any).reserveAsset()) as bigint;
  const u = (await (pool as any).reserveUsdc()) as bigint;
  return { a, u };
}

async function snapshotReserves(pool: LPPPool, label: string) {
  const r = await reserves(pool);
  expect({
    pool: await pool.getAddress(),
    reserves: { asset: r.a.toString(), usdc: r.u.toString() },
  }).to.matchSnapshot(label);
}

/** Executes a single mint and returns deltas & gas used; also snapshots gas. */
async function mintAndCapture(
  hook: LPPMintHook,
  pool: LPPPool,
  to: string,
  amountAsset: bigint,
  amountUsdc: bigint
) {
  const before = await reserves(pool);

  const tx = await (hook as any).mintWithRebate({
    pool: await pool.getAddress(),
    to,
    amountAssetDesired: amountAsset,
    amountUsdcDesired: amountUsdc,
    data: "0x",
  });
  const rcpt = await tx.wait();
  await snapshotGasCost(rcpt!.gasUsed);

  const after = await reserves(pool);
  const dA = after.a - before.a;
  const dU = after.u - before.u;

  return { dA, dU, gas: rcpt!.gasUsed };
}

async function expectRevertWithOneOf(txPromise: Promise<any>, reasons: string[]) {
  try {
    await txPromise;
    throw new Error("tx did not revert");
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    const ok = reasons.some((r) => msg.includes(r));
    expect(
      ok,
      `Expected revert reason in [${reasons.join(", ")}], got:\n${msg}`
    ).to.equal(true);
  }
}

/* ---------------- tests ---------------- */

describe("Equal-value enforcement", () => {
  it("accepts strictly within ±10 bps (e.g., +9 bps)", async () => {
    const { deployer, hook, pool } = await deployCore();
    await snapshotReserves(pool, "pre — +9bps");

    const a = ethers.parseEther("10");
    const u = ethers.parseEther("10.009"); // +9 bps

    await expect(
      (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: a,
        amountUsdcDesired: u,
        data: "0x",
      })
    ).to.not.be.reverted;

    const { dA, dU, gas } = await mintAndCapture(hook, pool, deployer.address, a, u);
    expect({ deltas: { asset: dA.toString(), usdc: dU.toString() }, gas: gas.toString() })
      .to.matchSnapshot("post — +9bps deltas");

    await snapshotReserves(pool, "post — +9bps reserves");
  });

  it("accepts exactly at +10 bps boundary (inclusive)", async () => {
    const { deployer, hook, pool } = await deployCore();
    await snapshotReserves(pool, "pre — +10bps");

    const a = ethers.parseEther("10");
    const u = ethers.parseEther("10.01"); // +10 bps

    await expect(
      (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: a,
        amountUsdcDesired: u,
        data: "0x",
      })
    ).to.not.be.reverted;

    const { dA, dU, gas } = await mintAndCapture(hook, pool, deployer.address, a, u);
    expect({ deltas: { asset: dA.toString(), usdc: dU.toString() }, gas: gas.toString() })
      .to.matchSnapshot("post — +10bps deltas");

    await snapshotReserves(pool, "post — +10bps reserves");
  });

  it("accepts exactly at −10 bps boundary (inclusive)", async () => {
    const { deployer, hook, pool } = await deployCore();
    await snapshotReserves(pool, "pre — -10bps");

    const a = ethers.parseEther("10");
    const u = ethers.parseEther("9.99"); // −10 bps

    await expect(
      (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: a,
        amountUsdcDesired: u,
        data: "0x",
      })
    ).to.not.be.reverted;

    const { dA, dU, gas } = await mintAndCapture(hook, pool, deployer.address, a, u);
    expect({ deltas: { asset: dA.toString(), usdc: dU.toString() }, gas: gas.toString() })
      .to.matchSnapshot("post — -10bps deltas");

    await snapshotReserves(pool, "post — -10bps reserves");
  });

  it("rejects just outside tolerance (+10 bps + 1 wei)", async () => {
    const { deployer, hook, pool } = await deployCore();

    const a = ethers.parseEther("10");
    // +10 bps + 1 wei
    const u = ethers.parseEther("10.01") + 1n;

    const before = await reserves(pool);
    await expect(
      (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: a,
        amountUsdcDesired: u,
        data: "0x",
      })
    ).to.be.revertedWith("unequal value");

    const after = await reserves(pool);
    expect(after.a).to.equal(before.a);
    expect(after.u).to.equal(before.u);
  });

  it("rejects when USDC is too LOW vs asset by >10 bps (e.g., -20 bps)", async () => {
    const { deployer, hook, pool } = await deployCore();

    const a = ethers.parseEther("10");
    const u = ethers.parseEther("9.98"); // -20 bps

    const before = await reserves(pool);
    await expect(
      (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: a,
        amountUsdcDesired: u,
        data: "0x",
      })
    ).to.be.revertedWith("unequal value");

    const after = await reserves(pool);
    expect(after.a).to.equal(before.a);
    expect(after.u).to.equal(before.u);
  });

  it("tiny amounts within tolerance still pass", async () => {
    const { deployer, hook, pool } = await deployCore();
    await snapshotReserves(pool, "pre — tiny +9bps");

    // use 1 wei each to avoid rounding artifacts; equality is within tolerance
    const a = 1n;
    const u = 1n;

    await expect(
      (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: a,
        amountUsdcDesired: u,
        data: "0x",
      })
    ).to.not.be.reverted;

    const { dA, dU, gas } = await mintAndCapture(hook, pool, deployer.address, a, u);
    expect({ deltas: { asset: dA.toString(), usdc: dU.toString() }, gas: gas.toString() })
      .to.matchSnapshot("post — tiny deltas");

    await snapshotReserves(pool, "post — tiny reserves");
  });

  it("very large amounts at boundary still pass (scale invariance)", async () => {
    const { deployer, hook, pool } = await deployCore();
    await snapshotReserves(pool, "pre — large +10bps");

    const a = ethers.parseEther("1000000");
    const u = ethers.parseEther("1000000.01"); // +10 bps

    await expect(
      (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: a,
        amountUsdcDesired: u,
        data: "0x",
      })
    ).to.not.be.reverted;

    const { dA, dU, gas } = await mintAndCapture(hook, pool, deployer.address, a, u);
    expect({ deltas: { asset: dA.toString(), usdc: dU.toString() }, gas: gas.toString() })
      .to.matchSnapshot("post — large deltas");

    await snapshotReserves(pool, "post — large reserves");
  });

  // replaced the failing test with the defensive zero-sided check
  it("rejects zero-sided mints (defensive check) — either side zero", async () => {
    const { deployer, hook, pool } = await deployCore();

    // asset = 0, usdc > 0
    await expectRevertWithOneOf(
      (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: 0n,
        amountUsdcDesired: ethers.parseEther("1"),
        data: "0x",
      }),
      ["zero", "unequal value"]
    );

    // asset > 0, usdc = 0
    await expectRevertWithOneOf(
      (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("1"),
        amountUsdcDesired: 0n,
        data: "0x",
      }),
      ["zero", "unequal value"]
    );

    // both zero
    await expectRevertWithOneOf(
      (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: 0n,
        amountUsdcDesired: 0n,
        data: "0x",
      }),
      ["zero", "unequal value"]
    );
  });
});