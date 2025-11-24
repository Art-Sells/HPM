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
async function snapshotParity(pool: LPPPool, label: string) {
  const details = {
    addresses: { pool: await addr(pool) },
    reserves: {
      asset: ((await (pool as any).reserveAsset()) as bigint).toString(),
      usdc:  ((await (pool as any).reserveUsdc())  as bigint).toString(),
    },
  };
  expect(details).to.matchSnapshot(`${label} — DETAILS`);
}

/** Price detail snapshot (linear + sqrt + drift + reserves) */
async function snapshotPriceDetail(pool: LPPPool, label: string) {
  const px = (await (pool as any).priceX96()) as bigint;

  const sqrtAssetPerUsdcX96 = toSqrtPriceX96(px);
  const sqrtUsdcPerAssetX96 = sqrtAssetPerUsdcX96 === 0n ? 0n : (Q192 / sqrtAssetPerUsdcX96);

  const resA = (await (pool as any).reserveAsset()) as bigint;
  const resU = (await (pool as any).reserveUsdc()) as bigint;

  expect({
    pool: await pool.getAddress(),
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
  treasury: LPPTreasury,
  factory: LPPFactory,
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
  treasury: LPPTreasury,
  factory: LPPFactory,
  assetAddr: string,
  usdcAddr: string
): Promise<LPPPool> {
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
  return (await ethers.getContractAt("LPPPool", poolAddr)) as unknown as LPPPool;
}

/** 4-arg version with offset bps: bootstrapViaTreasury(address,uint256,uint256,int256) */
async function bootstrapViaTreasury(
  treasury: LPPTreasury,
  pool: LPPPool,
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
  treasury: LPPTreasury | any,
  pool: LPPPool,
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
  treasury: LPPTreasury,
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

    const pool = e.pool as LPPPool;
    const treasury = e.treasury as LPPTreasury;
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

    const pool = e.pool as LPPPool;
    const treasury = e.treasury as LPPTreasury;
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

    const pool = e.pool as LPPPool;
    const treasury = e.treasury as LPPTreasury;
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

  it("bootstrap with zero amounts is rejected", async () => {
    const e: any = await deployCore();

    const pool = e.pool as LPPPool;
    const treasury = e.treasury as LPPTreasury;
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

    const treasury = e.treasury as LPPTreasury;
    const factory  = e.factory as LPPFactory;
    const asset    = e.asset as TestERC20;
    const usdc     = e.usdc as TestERC20;
    const deployer = e.deployer;

    const assetAddr = await asset.getAddress();
    const usdcAddr  = await usdc.getAddress();

    // Create four pools:
    //  - Pool A: center -500 bps
    //  - Pool B: center -499 bps
    //  - Pool C: center +499 bps
    //  - Pool D: center +500 bps
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

    await bootstrapViaTreasury(treasury, poolA, amtA, amtU, -500n);
    await bootstrapViaTreasury(treasury, poolB, amtA, amtU, -499n);
    await bootstrapViaTreasury(treasury, poolC, amtA, amtU,  499n);
    await bootstrapViaTreasury(treasury, poolD, amtA, amtU,  500n);

    await snapshotPriceDetail(poolA, "Offset seed — Pool A (-500 bps)");
    await snapshotPriceDetail(poolB, "Offset seed — Pool B (-499 bps)");
    await snapshotPriceDetail(poolC, "Offset seed — Pool C (+499 bps)");
    await snapshotPriceDetail(poolD, "Offset seed — Pool D (+500 bps)");
  });
});

describe("Bootstrap topology (bootstrap + orbits)", () => {
  it("bootstraps four pools and sets dual orbits atomically", async () => {
    const e: any = await deployCore();

    const treasury = e.treasury as LPPTreasury;
    const factory  = e.factory as LPPFactory;
    const router   = e.router as any;
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

    const pool0Addr = await pool0.getAddress();
    const pool1Addr = await pool1.getAddress();
    const pool2Addr = await pool2.getAddress();
    const pool3Addr = await pool3.getAddress();

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

    // Bootstrap all 4 pools and set orbits atomically
    const pools = [pool0Addr, pool1Addr, pool2Addr, pool3Addr];
    const amountsAsset = [amtA, amtA, amtA, amtA];
    const amountsUsdc = [amtU, amtU, amtU, amtU];
    const offsetsBps = [-500n, -500n, 500n, 500n];
    const negOrbit = [pool0Addr, pool1Addr];
    const posOrbit = [pool2Addr, pool3Addr];
    const routerAddr = await router.getAddress();

    const tx = await (treasury as any).bootstrapTopology(
      pools,
      amountsAsset,
      amountsUsdc,
      offsetsBps,
      routerAddr,
      negOrbit,
      posOrbit
    );
    const rcpt = await tx.wait();
    await snapshotGasCost(rcpt!.gasUsed);

    // Verify all pools are bootstrapped
    expect(await (pool0 as any).initialized()).to.be.true;
    expect(await (pool1 as any).initialized()).to.be.true;
    expect(await (pool2 as any).initialized()).to.be.true;
    expect(await (pool3 as any).initialized()).to.be.true;

    // Verify orbits are set for all pools
    for (const poolAddr of pools) {
      const dualOrbit = await router.getDualOrbit(poolAddr);
      // getDualOrbit returns (neg, pos, usingNeg) - if it doesn't revert, orbit is initialized
      expect(dualOrbit[0]).to.deep.equal(negOrbit); // NEG orbit
      expect(dualOrbit[1]).to.deep.equal(posOrbit); // POS orbit
      expect(dualOrbit[0].length).to.equal(2); // Should have 2 pools
      expect(dualOrbit[1].length).to.equal(2); // Should have 2 pools
    }

    // Verify offsets
    expect(await (pool0 as any).targetOffsetBps()).to.equal(-500n);
    expect(await (pool1 as any).targetOffsetBps()).to.equal(-500n);
    expect(await (pool2 as any).targetOffsetBps()).to.equal(500n);
    expect(await (pool3 as any).targetOffsetBps()).to.equal(500n);
  });
});