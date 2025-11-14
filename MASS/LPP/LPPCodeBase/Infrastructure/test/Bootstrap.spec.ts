// test/Bootstrap.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import snapshotGasCost from "./shared/snapshotGasCost.ts";
import { deployCore } from "./helpers.ts";

import type {
  LPPTreasury,
  LPPFactory,
  LPPPool,
  TestERC20,
} from "../typechain-types";

/* ---------------- math + price helpers ---------------- */

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;

function isqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

function toSqrtPriceX96(priceX96: bigint): bigint {
  return isqrt(priceX96 << 96n);
}

function driftBpsFromPriceX96(priceX96: bigint): string {
  const num = (priceX96 - Q96) * 10_000n;
  const den = Q96;
  const bps = num >= 0n ? num / den : -((-num) / den);
  return bps.toString();
}

async function addr(x: any): Promise<string> {
  if (!x) return "";
  if (typeof x === "string") return x;
  if ("getAddress" in x) return x.getAddress();
  if ("address" in x) return x.address;
  return "";
}

/** Reserve-only snapshot */
async function snapshotReserves(pool: LPPPool, label: string) {
  const a = await (pool as any).reserveAsset();
  const u = await (pool as any).reserveUsdc();
  expect({
    pool: await pool.getAddress(),
    reserves: {
      asset: a.toString(),
      usdc: u.toString(),
    },
  }).to.matchSnapshot(label);
}

/** Price & drift snapshot */
async function snapshotPrice(pool: LPPPool, label: string) {
  const px = await (pool as any).priceX96();
  const sqrtAperU = toSqrtPriceX96(px);
  const sqrtUperA = sqrtAperU === 0n ? 0n : Q192 / sqrtAperU;

  const resA = await (pool as any).reserveAsset();
  const resU = await (pool as any).reserveUsdc();

  expect({
    pool: await pool.getAddress(),
    priceX96: px.toString(),
    driftBps: driftBpsFromPriceX96(px),
    sqrtPrices: {
      sqrtAssetPerUsdcX96: sqrtAperU.toString(),
      sqrtUsdcPerAssetX96: sqrtUperA.toString(),
    },
    reserves: {
      asset: resA.toString(),
      usdc: resU.toString(),
    },
  }).to.matchSnapshot(label);
}

/* ---------------- helpers ---------------- */

async function allowPairViaTreasury(
  treasury: LPPTreasury,
  factory: LPPFactory,
  a: string,
  u: string
) {
  await (await treasury.allowTokenViaTreasury(await factory.getAddress(), a, true)).wait();
  await (await treasury.allowTokenViaTreasury(await factory.getAddress(), u, true)).wait();
}

async function newPoolViaTreasury(
  treasury: LPPTreasury,
  factory: LPPFactory,
  asset: string,
  usdc: string
) {
  await allowPairViaTreasury(treasury, factory, asset, usdc);
  const tx = await treasury.createPoolViaTreasury(await factory.getAddress(), asset, usdc);
  const rcpt = await tx.wait();
  await snapshotGasCost(rcpt!.gasUsed);

  const pools = await factory.getPools();
  const poolAddr = pools[pools.length - 1];
  return await ethers.getContractAt("LPPPool", poolAddr);
}

async function fundTreasury(
  asset: TestERC20,
  usdc: TestERC20,
  deployer: any,
  treasury: LPPTreasury,
  amtA: bigint,
  amtU: bigint
) {
  const t = await treasury.getAddress();
  await (await asset.connect(deployer).mint(t, amtA)).wait();
  await (await usdc.connect(deployer).mint(t, amtU)).wait();
}

/* ---------------- TESTS ---------------- */

describe("Bootstrap (Phase 0)", () => {

  it("Factory + single pool deployed correctly", async () => {
    const e = await deployCore();

    expect({
      factory: await addr(e.factory),
      pool: await addr(e.pool),
      reserves: {
        asset: (await e.pool.reserveAsset()).toString(),
        usdc: (await e.pool.reserveUsdc()).toString(),
      },
    }).to.matchSnapshot("Deploy — Factory + Pool");

    await snapshotPrice(e.pool, "Deploy — Baseline price");
  });

  it("cannot bootstrap twice", async () => {
    const e = await deployCore();

    await expect(
      e.treasury.bootstrapViaTreasury(
        await e.pool.getAddress(),
        1n,
        1n
      )
    ).to.be.revertedWith("already init");
  });

  it("only treasury owner can bootstrap", async () => {
    const e = await deployCore();
    const [ , notOwner ] = await ethers.getSigners();

    await expect(
      e.treasury.connect(notOwner).bootstrapViaTreasury(
        await e.pool.getAddress(),
        1n,
        1n
      )
    ).to.be.revertedWith("not owner");
  });

  it("bootstrap with zero amounts reverts", async () => {
    const e = await deployCore();

    const pool2 = await newPoolViaTreasury(
      e.treasury,
      e.factory,
      await e.asset.getAddress(),
      await e.usdc.getAddress()
    );

    await fundTreasury(e.asset, e.usdc, e.deployer, e.treasury, 10n, 10n);

    await expect(
      e.treasury.bootstrapViaTreasury(await pool2.getAddress(), 0n, 10n)
    ).to.be.revertedWith("zero amount");

    await expect(
      e.treasury.bootstrapViaTreasury(await pool2.getAddress(), 10n, 0n)
    ).to.be.revertedWith("zero amount");
  });

  it("offset bootstrap for four pools shows correct drift", async () => {
    const e = await deployCore();

    const asset = await e.asset.getAddress();
    const usdc = await e.usdc.getAddress();

    const poolA = await newPoolViaTreasury(e.treasury, e.factory, asset, usdc);
    const poolB = await newPoolViaTreasury(e.treasury, e.factory, asset, usdc);
    const poolC = await newPoolViaTreasury(e.treasury, e.factory, asset, usdc);
    const poolD = await newPoolViaTreasury(e.treasury, e.factory, asset, usdc);

    const amtA = ethers.parseEther("1");
    const amtU = ethers.parseEther("1");

    await fundTreasury(e.asset, e.usdc, e.deployer, e.treasury, amtA * 4n, amtU * 4n);

    await e.treasury.bootstrapViaTreasury(await poolA.getAddress(), amtA, amtU, -500n);
    await e.treasury.bootstrapViaTreasury(await poolB.getAddress(), amtA, amtU, -499n);
    await e.treasury.bootstrapViaTreasury(await poolC.getAddress(), amtA, amtU,  499n);
    await e.treasury.bootstrapViaTreasury(await poolD.getAddress(), amtA, amtU,  500n);

    await snapshotPrice(poolA, "Offset — Pool A (-500)");
    await snapshotPrice(poolB, "Offset — Pool B (-499)");
    await snapshotPrice(poolC, "Offset — Pool C (+499)");
    await snapshotPrice(poolD, "Offset — Pool D (+500)");
  });

});