// test/Bootstrap.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import snapshotGasCost from "./shared/snapshotGasCost.ts";
import { deployCore } from "./helpers.ts";

import type {
  FAFETreasury,
  FAFEFactory,
  FAFEPool,
  TestERC20,
} from "../typechain-types";

/* ---------------- math + price helpers ---------------- */

const Q96  = 1n << 96n;
const Q192 = 1n << 192n;

// integer sqrt
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

// priceX96 is linear Q96 price (asset / USDC)
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
  if ("getAddress" in x && typeof x.getAddress === "function") return await x.getAddress();
  if ("address" in x) return (x as any).address as string;
  return "";
}

/** Reserve-only parity snapshot (no ERC20 balance peeks) */
async function snapshotParity(pool: FAFEPool, label: string) {
  const details = {
    reserves: {
      asset: ((await (pool as any).reserveAsset()) as bigint).toString(),
      usdc:  ((await (pool as any).reserveUsdc())  as bigint).toString(),
    },
  };
  expect(details).to.matchSnapshot(`${label} — DETAILS`);
}

/** Price detail snapshot (linear + sqrt + drift + reserves) */
async function snapshotPriceDetail(pool: FAFEPool, label: string) {
  const px = (await (pool as any).priceX96()) as bigint;

  const sqrtAssetPerUsdcX96 = toSqrtPriceX96(px);
  const sqrtUsdcPerAssetX96 = sqrtAssetPerUsdcX96 === 0n ? 0n : (Q192 / sqrtAssetPerUsdcX96);

  const resA = (await (pool as any).reserveAsset()) as bigint;
  const resU = (await (pool as any).reserveUsdc()) as bigint;

  expect({
    priceX96: px.toString(),                 // asset / USDC (linear Q96)
    driftBps: driftBpsFromPriceX96(px),      // relative to 1.0
    sqrtPrices: {
      sqrtAssetPerUsdcX96: sqrtAssetPerUsdcX96.toString(),
      sqrtUsdcPerAssetX96: sqrtUsdcPerAssetX96.toString(),
    },
    reserves: {
      asset: resA.toString(),
      usdc:  resU.toString(),
    },
  }).to.matchSnapshot(label);
}

/* ---------------- local helpers (ERC20-aware) ---------------- */

async function allowPairViaTreasury(
  treasury: FAFETreasury,
  factory: FAFEFactory,
  a: string,
  u: string
) {
  await (await (treasury as any)["allowTokenViaTreasury(address,address,bool)"](
    await factory.getAddress(),
    a,
    true
  )).wait();

  await (await (treasury as any)["allowTokenViaTreasury(address,address,bool)"](
    await factory.getAddress(),
    u,
    true
  )).wait();
}

async function newPoolViaTreasuryWithTokens(
  treasury: FAFETreasury,
  factory: FAFEFactory,
  assetAddr: string,
  usdcAddr: string
): Promise<FAFEPool> {
  await allowPairViaTreasury(treasury, factory, assetAddr, usdcAddr);

  const tx = await (treasury as any)["createPoolViaTreasury(address,address,address)"](
    await factory.getAddress(),
    assetAddr,
    usdcAddr
  );
  const rcpt = await tx.wait();
  await snapshotGasCost(rcpt!.gasUsed);

  const pools = await (factory as any).getPools();
  const poolAddr = pools[pools.length - 1] as string;
  return (await ethers.getContractAt("FAFEPool", poolAddr)) as unknown as FAFEPool;
}

/** 4-arg version with offset bps: bootstrapViaTreasury(address,uint256,uint256,int256) */
async function bootstrapViaTreasury(
  treasury: FAFETreasury,
  pool: FAFEPool,
  amountAsset: bigint,
  amountUsdc: bigint,
  offsetBps: bigint
) {
  const fn = (treasury as any)[
    "bootstrapViaTreasury(address,uint256,uint256,int256)"
  ] as (
    pool: string,
    amountAsset: bigint,
    amountUsdc: bigint,
    offsetBps: bigint
  ) => Promise<any>;

  const tx = await fn(
    await pool.getAddress(),
    amountAsset,
    amountUsdc,
    offsetBps
  );
  const rcpt = await tx.wait();
  await snapshotGasCost(rcpt!.gasUsed);
}

/** 3-arg overload: bootstrapViaTreasury(address,uint256,uint256) */
/** 3-arg overload: bootstrapViaTreasury(address,uint256,uint256) */
async function threeArgBootstrap(
  treasury: FAFETreasury | any,
  pool: FAFEPool,
  amountAsset: bigint,
  amountUsdc: bigint
) {
  const fn3 = (treasury as any)[
    "bootstrapViaTreasury(address,uint256,uint256)"
  ] as (
    pool: string,
    amountAsset: bigint,
    amountUsdc: bigint
  ) => Promise<any>;

  return fn3(
    await pool.getAddress(),   // <<--- await the Promise<string> here
    amountAsset,
    amountUsdc
  );
}

/** Mint tokens to Treasury so it can bootstrap pools */
async function fundTreasuryForBootstrap(
  asset: TestERC20,
  usdc: TestERC20,
  deployer: any,
  treasury: FAFETreasury,
  totalAsset: bigint,
  totalUsdc: bigint
) {
  const tAddr = await treasury.getAddress();

  if (totalAsset > 0n) {
    await (await asset.connect(deployer).mint(tAddr, totalAsset)).wait();
  }
  if (totalUsdc > 0n) {
    await (await usdc.connect(deployer).mint(tAddr, totalUsdc)).wait();
  }
}

/* ---------------- tests ---------------- */

describe("Bootstrap", () => {
  it("bootstrap initializes reserves and price", async () => {
    const e: any = await deployCore(); // cast to any to avoid TS complaining about shape

    const pool = e.pool as FAFEPool;
    const treasury = e.treasury as FAFETreasury;
    const asset = e.asset as TestERC20;
    const usdc = e.usdc as TestERC20;
    const deployer = e.deployer;

    // Before bootstrap: expect zero reserves
    const beforeA = (await (pool as any).reserveAsset()) as bigint;
    const beforeU = (await (pool as any).reserveUsdc()) as bigint;

    expect(beforeA).to.equal(0n);
    expect(beforeU).to.equal(0n);

    // Mint funds to Treasury and bootstrap
    const amtA = ethers.parseEther("1");
    const amtU = ethers.parseEther("1");

    await fundTreasuryForBootstrap(asset, usdc, deployer, treasury, amtA, amtU);

    await bootstrapViaTreasury(treasury, pool, amtA, amtU, 0n);

    const afterA = (await (pool as any).reserveAsset()) as bigint;
    const afterU = (await (pool as any).reserveUsdc()) as bigint;

    expect(afterA).to.equal(amtA);
    expect(afterU).to.equal(amtU);

    await snapshotParity(pool, "Bootstrap — post-bootstrap parity");
    await snapshotPriceDetail(pool, "Bootstrap — Baseline price fields");
  });

  it("cannot bootstrap twice (idempotency enforced)", async () => {
    const e: any = await deployCore();

    const pool = e.pool as FAFEPool;
    const treasury = e.treasury as FAFETreasury;
    const asset = e.asset as TestERC20;
    const usdc = e.usdc as TestERC20;
    const deployer = e.deployer;

    const amtA = ethers.parseEther("1");
    const amtU = ethers.parseEther("1");

    await fundTreasuryForBootstrap(asset, usdc, deployer, treasury, amtA * 2n, amtU * 2n);
    await bootstrapViaTreasury(treasury, pool, amtA, amtU, 0n);

    // Second call (3-arg overload) should revert with "already init"
    await expect(
      threeArgBootstrap(treasury, pool, amtA, amtU)
    ).to.be.revertedWith("already init");
  });

  it("only Treasury owner can call bootstrapViaTreasury", async () => {
    const e: any = await deployCore();

    const pool = e.pool as FAFEPool;
    const treasury = e.treasury as FAFETreasury;
    const asset = e.asset as TestERC20;
    const usdc = e.usdc as TestERC20;
    const deployer = e.deployer;
    const [, notOwner] = await ethers.getSigners();

    const amtA = ethers.parseEther("1");
    const amtU = ethers.parseEther("1");

    await fundTreasuryForBootstrap(asset, usdc, deployer, treasury, amtA, amtU);

    await expect(
      threeArgBootstrap(treasury.connect(notOwner), pool, amtA, amtU)
    ).to.be.revertedWith("not owner");
  });

  it("unauthorized caller cannot call bootstrapInitialize directly on pool", async () => {
    const e: any = await deployCore();

    const pool = e.pool as FAFEPool;
    const asset = e.asset as TestERC20;
    const usdc = e.usdc as TestERC20;
    const deployer = e.deployer;
    const [, unauthorized] = await ethers.getSigners();

    const amtA = ethers.parseEther("1");
    const amtU = ethers.parseEther("1");

    // Fund the unauthorized caller
    await (await asset.connect(deployer).mint(unauthorized.address, amtA)).wait();
    await (await usdc.connect(deployer).mint(unauthorized.address, amtU)).wait();

    // Approve pool to transfer tokens
    await (await asset.connect(unauthorized).approve(await pool.getAddress(), amtA)).wait();
    await (await usdc.connect(unauthorized).approve(await pool.getAddress(), amtU)).wait();

    // Try to call bootstrapInitialize directly - should revert with "only auth"
    await expect(
      (pool as any).connect(unauthorized).bootstrapInitialize(amtA, amtU, 0n)
    ).to.be.revertedWith("only auth");
  });

  it("bootstrap with zero amounts is rejected", async () => {
    const e: any = await deployCore();

    const pool = e.pool as FAFEPool;
    const treasury = e.treasury as FAFETreasury;
    const asset = e.asset as TestERC20;
    const usdc = e.usdc as TestERC20;
    const deployer = e.deployer;

    const amtA = ethers.parseEther("1");
    const amtU = ethers.parseEther("1");

    await fundTreasuryForBootstrap(asset, usdc, deployer, treasury, amtA, amtU);

    await expect(
      threeArgBootstrap(treasury, pool, 0n, amtU)
    ).to.be.revertedWith("zero amount");

    await expect(
      threeArgBootstrap(treasury, pool, amtA, 0n)
    ).to.be.revertedWith("zero amount");
  });
});

describe("Offset bootstrap seeding", () => {
  it("seeds four pools off-center and snapshots drift (bps)", async () => {
    const e: any = await deployCore();

    const treasury = e.treasury as FAFETreasury;
    const factory  = e.factory as FAFEFactory;
    const asset    = e.asset as TestERC20;
    const usdc     = e.usdc as TestERC20;
    const deployer = e.deployer;

    const assetAddr = await asset.getAddress();
    const usdcAddr  = await usdc.getAddress();

    // Create four pools:
    //  - Pool A: -5000 bps
    //  - Pool B: -4999 bps
    //  - Pool C: +4999 bps
    //  - Pool D: +5000 bps
    const poolA = await newPoolViaTreasuryWithTokens(treasury, factory, assetAddr, usdcAddr);
    const poolB = await newPoolViaTreasuryWithTokens(treasury, factory, assetAddr, usdcAddr);
    const poolC = await newPoolViaTreasuryWithTokens(treasury, factory, assetAddr, usdcAddr);
    const poolD = await newPoolViaTreasuryWithTokens(treasury, factory, assetAddr, usdcAddr);

    const amtA = ethers.parseEther("1"); // 1 ASSET
    const amtU = ethers.parseEther("1"); // 1 USDC

    // Fund Treasury once with enough for all four boots (4 pools * (1,1))
    await fundTreasuryForBootstrap(
      asset,
      usdc,
      deployer,
      treasury,
      amtA * 4n,
      amtU * 4n
    );

    await bootstrapViaTreasury(treasury, poolA, amtA, amtU, -5000n);
    await bootstrapViaTreasury(treasury, poolB, amtA, amtU, -4999n);
    await bootstrapViaTreasury(treasury, poolC, amtA, amtU,  4999n);
    await bootstrapViaTreasury(treasury, poolD, amtA, amtU,  5000n);

    await snapshotPriceDetail(poolA, "Offset seed — Pool A (-5000 bps)");
    await snapshotPriceDetail(poolB, "Offset seed — Pool B (-4999 bps)");
    await snapshotPriceDetail(poolC, "Offset seed — Pool C (+4999 bps)");
    await snapshotPriceDetail(poolD, "Offset seed — Pool D (+5000 bps)");
  });
});

describe("Bootstrap topology (bootstrap multiple pools)", () => {
  it("bootstraps four pools with different offsets", async () => {
    const e: any = await deployCore();

    const treasury = e.treasury as FAFETreasury;
    const factory  = e.factory as FAFEFactory;
    const asset    = e.asset as TestERC20;
    const usdc     = e.usdc as TestERC20;
    const deployer = e.deployer;

    const assetAddr = await asset.getAddress();
    const usdcAddr  = await usdc.getAddress();

    // Create four pools
    const pool0 = await newPoolViaTreasuryWithTokens(treasury, factory, assetAddr, usdcAddr);
    const pool1 = await newPoolViaTreasuryWithTokens(treasury, factory, assetAddr, usdcAddr);
    const pool2 = await newPoolViaTreasuryWithTokens(treasury, factory, assetAddr, usdcAddr);
    const pool3 = await newPoolViaTreasuryWithTokens(treasury, factory, assetAddr, usdcAddr);

    const amtA = ethers.parseEther("1"); // 1 ASSET
    const amtU = ethers.parseEther("1"); // 1 USDC

    // Fund Treasury with enough for all four pools
    await fundTreasuryForBootstrap(
      asset,
      usdc,
      deployer,
      treasury,
      amtA * 4n,
      amtU * 4n
    );

    // Bootstrap all 4 pools individually with different offsets
    await bootstrapViaTreasury(treasury, pool0, amtA, amtU, -5000n);
    await bootstrapViaTreasury(treasury, pool1, amtA, amtU, -5000n);
    await bootstrapViaTreasury(treasury, pool2, amtA, amtU, 5000n);
    await bootstrapViaTreasury(treasury, pool3, amtA, amtU, 5000n);

    // Verify all pools are bootstrapped
    expect(await (pool0 as any).initialized()).to.be.true;
    expect(await (pool1 as any).initialized()).to.be.true;
    expect(await (pool2 as any).initialized()).to.be.true;
    expect(await (pool3 as any).initialized()).to.be.true;

    // Verify offsets
    expect(await (pool0 as any).targetOffsetBps()).to.equal(-5000n);
    expect(await (pool1 as any).targetOffsetBps()).to.equal(-5000n);
    expect(await (pool2 as any).targetOffsetBps()).to.equal(5000n);
    expect(await (pool3 as any).targetOffsetBps()).to.equal(5000n);
  });
});

describe("Offset bounds validation", () => {
  it("rejects offset greater than +10000 bps", async () => {
    const e: any = await deployCore();

    const pool = e.pool as FAFEPool;
    const treasury = e.treasury as FAFETreasury;
    const asset = e.asset as TestERC20;
    const usdc = e.usdc as TestERC20;
    const deployer = e.deployer;

    const amtA = ethers.parseEther("1");
    const amtU = ethers.parseEther("1");

    await fundTreasuryForBootstrap(asset, usdc, deployer, treasury, amtA, amtU);

    // Should revert with "offset out of bounds"
    await expect(
      bootstrapViaTreasury(treasury, pool, amtA, amtU, 10001n)
    ).to.be.revertedWith("offset out of bounds");
  });

  it("rejects offset less than -10000 bps", async () => {
    const e: any = await deployCore();

    const pool = e.pool as FAFEPool;
    const treasury = e.treasury as FAFETreasury;
    const asset = e.asset as TestERC20;
    const usdc = e.usdc as TestERC20;
    const deployer = e.deployer;

    const amtA = ethers.parseEther("1");
    const amtU = ethers.parseEther("1");

    await fundTreasuryForBootstrap(asset, usdc, deployer, treasury, amtA, amtU);

    // Should revert - for -10001, (10000 + (-10001)) = -1, making combined negative, so "bad offset"
    // The bounds check happens after, but we never reach it
    await expect(
      bootstrapViaTreasury(treasury, pool, amtA, amtU, -10001n)
    ).to.be.revertedWith("bad offset");
  });

  it("accepts offset at exactly +10000 bps", async () => {
    const e: any = await deployCore();

    const pool = e.pool as FAFEPool;
    const treasury = e.treasury as FAFETreasury;
    const asset = e.asset as TestERC20;
    const usdc = e.usdc as TestERC20;
    const deployer = e.deployer;

    const amtA = ethers.parseEther("1");
    const amtU = ethers.parseEther("1");

    await fundTreasuryForBootstrap(asset, usdc, deployer, treasury, amtA, amtU);

    // Should succeed at exactly +10000
    await bootstrapViaTreasury(treasury, pool, amtA, amtU, 10000n);
    expect(await (pool as any).targetOffsetBps()).to.equal(10000n);
  });

  it("rejects offset at exactly -10000 bps (makes price calculation invalid)", async () => {
    const e: any = await deployCore();

    const pool = e.pool as FAFEPool;
    const treasury = e.treasury as FAFETreasury;
    const asset = e.asset as TestERC20;
    const usdc = e.usdc as TestERC20;
    const deployer = e.deployer;

    const amtA = ethers.parseEther("1");
    const amtU = ethers.parseEther("1");

    await fundTreasuryForBootstrap(asset, usdc, deployer, treasury, amtA, amtU);

    // For -10000, (10000 + (-10000)) = 0, making combined = 0, so "bad offset"
    // This fails before the bounds check
    await expect(
      bootstrapViaTreasury(treasury, pool, amtA, amtU, -10000n)
    ).to.be.revertedWith("bad offset");
  });

  it("accepts offset at exactly -9999 bps (maximum negative that works)", async () => {
    const e: any = await deployCore();

    const pool = e.pool as FAFEPool;
    const treasury = e.treasury as FAFETreasury;
    const asset = e.asset as TestERC20;
    const usdc = e.usdc as TestERC20;
    const deployer = e.deployer;

    const amtA = ethers.parseEther("1");
    const amtU = ethers.parseEther("1");

    await fundTreasuryForBootstrap(asset, usdc, deployer, treasury, amtA, amtU);

    // Should succeed at -9999 (one less than -10000, which would make combined = 0)
    await bootstrapViaTreasury(treasury, pool, amtA, amtU, -9999n);
    expect(await (pool as any).targetOffsetBps()).to.equal(-9999n);
  });
});