// test/helpers.ts
import hre from "hardhat";
const { ethers } = hre;

import type {
  FAFEAccessManager,
  FAFETreasury,
  FAFERouter,
  FAFEFactory,
  FAFEPool,
  TestERC20,
} from "../typechain-types";

/** Common constants for bootstrap in tests */
export const A = ethers.parseEther("100");
export const U = ethers.parseEther("100");

export interface DeployCoreResult {
  deployer: any;
  other: any;
  access: FAFEAccessManager;
  treasury: FAFETreasury;
  router: FAFERouter;
  factory: FAFEFactory;
  pool: FAFEPool;
  asset: TestERC20;
  usdc: TestERC20;
  assetAddr: string;
  usdcAddr: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Core deployment (Access → Treasury → Router → Factory → Tokens → Pool)
 * ──────────────────────────────────────────────────────────────────────────── */
export async function deployCore(): Promise<DeployCoreResult> {
  const [deployer, other] = await ethers.getSigners();

  // 1) Access Manager
  const Access = await ethers.getContractFactory("FAFEAccessManager");
  const access = (await Access.deploy()) as FAFEAccessManager;
  await access.waitForDeployment();

  // 2) Treasury
  const Treasury = await ethers.getContractFactory("FAFETreasury");
  const treasury = (await Treasury.deploy()) as FAFETreasury;
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();

  // 2a) Set treasury on AccessManager (required for setDedicatedAA)
  await (await access.setTreasury(treasuryAddr)).wait();

  // 3) Router (access, treasury)
  const Router = await ethers.getContractFactory("FAFERouter");
  const router = (await Router.deploy(
    await access.getAddress(),
    treasuryAddr
  )) as FAFERouter;
  await router.waitForDeployment();

  // 4) Factory (treasury)
  const Factory = await ethers.getContractFactory("FAFEFactory");
  const factory = (await Factory.deploy(treasuryAddr)) as FAFEFactory;
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
  const pool = (await ethers.getContractAt("FAFEPool", poolAddr)) as FAFEPool;

  // 8) Set router on pool (required for flipOffset)
  await (await pool.setRouter(await router.getAddress())).wait();

  // 9) Fund Treasury with tokens for bootstrap tests
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

/* ────────────────────────────────────────────────────────────────────────────
 * Bootstrap helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/** Overload-safe caller for Treasury.bootstrapViaTreasury (4-arg version with offsetBps) */
export async function bootstrapPool(
  treasury: FAFETreasury,
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

  await (
    await (treasury as any)["bootstrapViaTreasury(address,uint256,uint256,int256)"](
      poolAddr, amountAsset, amountUsdc, offsetBps
    )
  ).wait();
}

/** Optional: 3-arg overload (offset = 0) */
export async function bootstrapPoolNoOffset(
  treasury: FAFETreasury,
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
  factory: FAFEFactory,
  treasury: FAFETreasury,
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
  factory: FAFEFactory,
  treasury: FAFETreasury,
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
  treasury: FAFETreasury,
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
  treasury: FAFETreasury,
  asset: TestERC20,
  usdc: TestERC20
) {
  if (pools.length < 6) throw new Error("need at least 6 pools");
  for (let i = 0; i < 3; i++) {
    await bootstrapPool(treasury, pools[i], asset, usdc, A, U, -500);
  }
  for (let i = 3; i < 6; i++) {
    await bootstrapPool(treasury, pools[i], asset, usdc, A, U, +500);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Dedicated AA setup
 * ──────────────────────────────────────────────────────────────────────────── */

export async function setDedicatedAA(
  treasury: FAFETreasury,
  access: FAFEAccessManager,
  aaAddress: string,
  caller?: any // Optional: if provided, use this signer (for treasury owner)
) {
  // Treasury calls setDedicatedAAViaTreasury, which calls access.setDedicatedAA
  // setDedicatedAA now requires msg.sender == treasury (set via setTreasury)
  const treasuryOwner = caller || (await ethers.getSigner(await treasury.owner()));
  const tx = await treasury.connect(treasuryOwner).setDedicatedAAViaTreasury(await access.getAddress(), aaAddress);
  const receipt = await tx.wait();
  
  // Verify the event was emitted
  const iface = access.interface;
  const event = iface.getEvent("DedicatedAASet");
  const found = receipt?.logs.find((log: any) => {
    try {
      return iface.parseLog(log)?.name === "DedicatedAASet";
    } catch {
      return false;
    }
  });
  
  if (!found) {
    throw new Error("DedicatedAASet event not found in transaction");
  }
  
  return receipt;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Token helpers
 * ──────────────────────────────────────────────────────────────────────────── */

export async function getTokensFromPoolAddr(poolAddr: string) {
  const pool = (await ethers.getContractAt("FAFEPool", poolAddr)) as FAFEPool;
  const assetAddr = await pool.asset();
  const usdcAddr  = await pool.usdc();
  const asset = (await ethers.getContractAt("TestERC20", assetAddr)) as TestERC20;
  const usdc  = (await ethers.getContractAt("TestERC20", usdcAddr))  as TestERC20;
  return { pool, asset, usdc, assetAddr, usdcAddr };
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

/* ────────────────────────────────────────────────────────────────────────────
 * Permissioned single-pool path (SUPPLICATE)
 * ──────────────────────────────────────────────────────────────────────────── */

export async function approveSupplicator(
  access: FAFEAccessManager,
  who: string,
  approved = true,
  caller?: any // Optional: if provided, use this signer (for access manager owner)
) {
  // If caller provided, use it; otherwise get the current owner
  const ownerAddr = await access.owner();
  const signer = caller || (await ethers.getSigner(ownerAddr));
  await (await access.connect(signer).setApprovedSupplicator(who, approved)).wait();
}

/** Runs a single-pool supplicate (permissioned). Approves router (fee) + pool (principal). */
export async function runSupplicate(params: {
  router: FAFERouter;
  caller: any;               // signer (must be an approved supplicator)
  poolAddr: string;
  assetToUsdc: boolean;
  amountIn: bigint;
  minAmountOut?: bigint;
  to?: string;
  payer?: string;
}) {
  const { router, caller, poolAddr, assetToUsdc, amountIn } = params;
  const minAmountOut = params.minAmountOut ?? 0n;
  const to = params.to ?? caller.address;
  const payer = params.payer ?? caller.address;

  const { asset, usdc } = await getTokensFromPoolAddr(poolAddr);
  const tokenIn = assetToUsdc ? asset : usdc;

  // Router pulls the fee; pool pulls the principal -> approvals needed for both.
  await approveMax(tokenIn, caller, poolAddr);

  const tx = await (router.connect(caller) as any).supplicate({
    pool: poolAddr,
    assetToUsdc,
    amountIn,
    minAmountOut,
    to,
    payer,
  });
  return await tx.wait();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Single-pool swap (permissioned, only dedicated AA) — flips offset after swap
 * ──────────────────────────────────────────────────────────────────────────── */

/** Quote a swap operation */
export async function quoteSwap(
  router: FAFERouter,
  poolAddr: string,
  assetToUsdc: boolean,
  amountIn: bigint
) {
  return await router.quoteSwap(poolAddr, assetToUsdc, amountIn);
}

/** Execute a single-pool swap (permissioned, only dedicated AA can call).
 *  - Requires caller to be the dedicated AA address
 *  - Approves pool for principal
 *  - Calls router.swap() which flips offset after execution
 */
export async function runSwap(params: {
  router: FAFERouter;
  caller: any;               // signer (must be dedicated AA)
  poolAddr: string;
  assetToUsdc: boolean;
  amountIn: bigint;
  minAmountOut?: bigint;
  to?: string;
  payer?: string;
}) {
  const { router, caller, poolAddr, assetToUsdc, amountIn } = params;
  const minAmountOut = params.minAmountOut ?? 0n;
  const to = params.to ?? caller.address;
  const payer = params.payer ?? caller.address;

  const { asset, usdc } = await getTokensFromPoolAddr(poolAddr);
  const tokenIn = assetToUsdc ? asset : usdc;

  // Approve pool for principal
  await approveMax(tokenIn, caller, poolAddr);

  // Call the swap function (only dedicated AA can call)
  const tx = await (router.connect(caller) as any).swap({
    pool: poolAddr,
    assetToUsdc,
    amountIn,
    minAmountOut,
    to,
    payer,
  });
  return await tx.wait();
}

/** Execute a deposit operation (permissioned, any approved supplicator) */
export async function runDeposit(params: {
  router: FAFERouter;
  caller: any;               // signer (must be approved supplicator)
  poolAddr: string;
  isUsdc: boolean;
  amount: bigint;
}) {
  const { router, caller, poolAddr, isUsdc, amount } = params;

  const { asset, usdc } = await getTokensFromPoolAddr(poolAddr);
  const token = isUsdc ? usdc : asset;

  // Approve router for the deposit amount
  await approveMax(token, caller, await router.getAddress());

  // Call the deposit function
  const tx = await (router.connect(caller) as any).deposit({
    pool: poolAddr,
    isUsdc,
    amount,
  });
  return await tx.wait();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Read helpers for tests
 * ──────────────────────────────────────────────────────────────────────────── */

export async function getReservesLike(pool: FAFEPool) {
  const [rA, rU] = await Promise.all([pool.reserveAsset(), pool.reserveUsdc()]);
  return { reserveAsset: BigInt(rA.toString()), reserveUsdc: BigInt(rU.toString()) };
}