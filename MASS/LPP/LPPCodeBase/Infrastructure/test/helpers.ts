// test/helpers.ts
import hre from "hardhat";
const { ethers } = hre;

import type {
  LPPAccessManager,
  LPPTreasury,
  LPPRouter,
  LPPFactory,
  LPPPool,
  TestERC20,
} from "../typechain-types";

/** Common constants for bootstrap in tests */
export const A = ethers.parseEther("100");
export const U = ethers.parseEther("100");

export interface DeployCoreResult {
  deployer: any;
  other: any;
  access: LPPAccessManager;
  treasury: LPPTreasury;
  router: LPPRouter;
  factory: LPPFactory;
  pool: LPPPool;
  asset: TestERC20;
  usdc: TestERC20;
  assetAddr: string;
  usdcAddr: string;
}

/** Deploys AccessManager, Treasury, Router, Factory, Test tokens, creates first pool, and funds Treasury */
export async function deployCore(): Promise<DeployCoreResult> {
  const [deployer, other] = await ethers.getSigners();

  // 1) Access Manager
  const Access = await ethers.getContractFactory("LPPAccessManager");
  const access = (await Access.deploy()) as LPPAccessManager;
  await access.waitForDeployment();

  // 2) Treasury
  const Treasury = await ethers.getContractFactory("LPPTreasury");
  const treasury = (await Treasury.deploy()) as LPPTreasury;
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();

  // 3) Router (access, treasury)
  const Router = await ethers.getContractFactory("LPPRouter");
  const router = (await Router.deploy(
    await access.getAddress(),
    treasuryAddr
  )) as LPPRouter;
  await router.waitForDeployment();

  // 4) Factory (treasury)
  const Factory = await ethers.getContractFactory("LPPFactory");
  const factory = (await Factory.deploy(treasuryAddr)) as LPPFactory;
  await factory.waitForDeployment();

  // 5) Test tokens (3-arg constructor)
  const ERC20 = await ethers.getContractFactory("TestERC20");
  const asset = (await ERC20.deploy("ASSET", "AST", deployer.address)) as TestERC20;
  const usdc  = (await ERC20.deploy("USDC", "USDC", deployer.address)) as TestERC20;
  await asset.waitForDeployment();
  await usdc.waitForDeployment();

  const assetAddr = await asset.getAddress();
  const usdcAddr  = await usdc.getAddress();

  // Mint a large balance to deployer for tests
  const BIG = ethers.parseEther("100000000");
  await (await asset.mint(deployer.address, BIG)).wait();
  await (await usdc.mint(deployer.address,  BIG)).wait();

  // 6) Allow-list tokens via Treasury → Factory
  await (await treasury.allowTokenViaTreasury(await factory.getAddress(), assetAddr, true)).wait();
  await (await treasury.allowTokenViaTreasury(await factory.getAddress(), usdcAddr,  true)).wait();

  // 7) Create first pool via Treasury → Factory
  await (
    await treasury.createPoolViaTreasury(
      await factory.getAddress(),
      assetAddr,
      usdcAddr
    )
  ).wait();

  const pools = await factory.getPools();
  const poolAddr = pools[0];
  const pool = (await ethers.getContractAt("LPPPool", poolAddr)) as LPPPool;

  // 8) Fund Treasury with tokens for bootstrap tests
  await (await asset.mint(treasuryAddr, ethers.parseEther("1000"))).wait();
  await (await usdc.mint(treasuryAddr,  ethers.parseEther("1000"))).wait();

  return {
    deployer,
    other,
    access,
    treasury,
    router,
    factory,
    pool,
    asset,
    usdc,
    assetAddr,
    usdcAddr,
  };
}

/** Overload-safe caller for Treasury.bootstrapViaTreasury (4-arg version with offsetBps) */
export async function bootstrapPool(
  treasury: LPPTreasury,
  poolAddr: string,
  asset: TestERC20,
  usdc: TestERC20,
  amountAsset: bigint,
  amountUsdc: bigint,
  offsetBps: number = 0
) {
  // top up Treasury if needed
  const tAddr = await treasury.getAddress();
  const balA = await asset.balanceOf(tAddr);
  const balU = await usdc.balanceOf(tAddr);
  if (balA < amountAsset) await (await asset.mint(tAddr, amountAsset - balA)).wait();
  if (balU < amountUsdc)  await (await usdc.mint(tAddr,  amountUsdc  - balU)).wait();

  // call overloaded function by full signature (ethers v6 + TypeChain)
  await (
    await (treasury as any)["bootstrapViaTreasury(address,uint256,uint256,int256)"](
      poolAddr, amountAsset, amountUsdc, offsetBps
    )
  ).wait();
}

/** Optional: 3-arg overload (offset = 0) */
export async function bootstrapPoolNoOffset(
  treasury: LPPTreasury,
  poolAddr: string,
  amountAsset: bigint,
  amountUsdc: bigint
) {
  await (
    await (treasury as any)["bootstrapViaTreasury(address,uint256,uint256)"](
      poolAddr, amountAsset, amountUsdc
    )
  ).wait();
}

/** Ensure we have N pools total; create missing ones via Treasury */
export async function ensureNPools(
  factory: LPPFactory,
  treasury: LPPTreasury,
  assetAddr: string,
  usdcAddr: string,
  n: number
): Promise<string[]> {
  const have = (await factory.getPools()).length;
  for (let i = have; i < n; i++) {
    await (
      await treasury.createPoolViaTreasury(
        await factory.getAddress(),
        assetAddr,
        usdcAddr
      )
    ).wait();
  }
  return await factory.getPools();
}

/** Ensure exactly 6 pools exist (returns first 6) */
export async function ensureSixPools(
  factory: LPPFactory,
  treasury: LPPTreasury,
  asset: TestERC20,
  usdc: TestERC20
): Promise<string[]> {
  const assetAddr = await asset.getAddress();
  const usdcAddr  = await usdc.getAddress();

  // Make sure tokens are allow-listed (idempotent)
  await (await treasury.allowTokenViaTreasury(await factory.getAddress(), assetAddr, true)).wait();
  await (await treasury.allowTokenViaTreasury(await factory.getAddress(), usdcAddr,  true)).wait();

  const all = await ensureNPools(factory, treasury, assetAddr, usdcAddr, 6);
  return all.slice(0, 6);
}

/** Bootstrap many pools with per-pool offsets */
export async function bootstrapMany(
  treasury: LPPTreasury,
  pools: string[],
  asset: TestERC20,
  usdc: TestERC20,
  amountAsset: bigint,
  amountUsdc: bigint,
  offsetsBps: number[]
) {
  const k = Math.min(pools.length, offsetsBps.length);
  for (let i = 0; i < k; i++) {
    await bootstrapPool(
      treasury,
      pools[i],
      asset,
      usdc,
      amountAsset,
      amountUsdc,
      offsetsBps[i]
    );
  }
}

/** Convenience: bootstrap 3 NEG (-500 bps) and 3 POS (+500 bps) */
export async function bootstrapSix(
  pools: string[],
  treasury: LPPTreasury,
  asset: TestERC20,
  usdc: TestERC20
) {
  if (pools.length < 6) throw new Error("need at least 6 pools");
  // first 3 NEG (-500), last 3 POS (+500)
  for (let i = 0; i < 3; i++) {
    await bootstrapPool(treasury, pools[i], asset, usdc, A, U, -500);
  }
  for (let i = 3; i < 6; i++) {
    await bootstrapPool(treasury, pools[i], asset, usdc, A, U, +500);
  }
}

/** Approve a caller as a supplicator (router.supplicate requires this) */
export async function approveSupplicator(access: LPPAccessManager, who: string, approved = true) {
  await (await access.setApprovedSupplicator(who, approved)).wait();
}

/** Utility: approve max allowance to a spender (ethers v6) */
export async function approveMax(token: TestERC20, owner: any, spender: string) {
  await (await token.connect(owner).approve(spender, ethers.MaxUint256)).wait();
}

/** Utility: approve max to many spenders */
export async function approveMaxMany(token: TestERC20, owner: any, spenders: string[]) {
  for (const s of spenders) {
    await approveMax(token, owner, s);
  }
}

/** Read reserves from a pool (V2-style helper for tests) */
export async function getReservesLike(pool: LPPPool) {
  const [r0, r1] = await Promise.all([pool.reserveAsset(), pool.reserveUsdc()]);
  return { reserveAsset: BigInt(r0.toString()), reserveUsdc: BigInt(r1.toString()) };
}