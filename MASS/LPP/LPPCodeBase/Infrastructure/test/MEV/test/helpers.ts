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
} from "../../../typechain-types";

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

/* ────────────────────────────────────────────────────────────────────────────
 * Core deployment (Access → Treasury → Router → Factory → Tokens → Pool)
 * ──────────────────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────────────────────
 * Bootstrap helpers
 * ──────────────────────────────────────────────────────────────────────────── */

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
  for (let i = 0; i < 3; i++) {
    await bootstrapPool(treasury, pools[i], asset, usdc, A, U, -500);
  }
  for (let i = 3; i < 6; i++) {
    await bootstrapPool(treasury, pools[i], asset, usdc, A, U, +500);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Orbit wiring (treasury-only on Router implementation)
 * ──────────────────────────────────────────────────────────────────────────── */

export async function wireLegacyOrbit(
  treasury: LPPTreasury,
  router: LPPRouter,
  startPool: string,
  orbit: [string, string, string]
) {
  await (await treasury.setOrbitViaTreasury(await router.getAddress(), startPool, orbit)).wait();
}

export async function wireDualOrbit(
  treasury: LPPTreasury,
  router: LPPRouter,
  startPool: string,
  neg: [string, string, string],
  pos: [string, string, string],
  startWithNeg = true
) {
  await (
    await treasury.setDualOrbitViaTreasury(
      await router.getAddress(),
      startPool,
      neg,
      pos,
      startWithNeg
    )
  ).wait();
}

type OrbitOffsets = Array<number | bigint>;

async function bootstrapIfNeeded(
  poolAddr: string,
  treasury: LPPTreasury,
  asset: TestERC20,
  usdc: TestERC20,
  offsetBps: number
) {
  const pool = await ethers.getContractAt("LPPPool", poolAddr);
  const initialized = await pool.initialized();
  if (initialized) return;
  await bootstrapPool(treasury, poolAddr, asset, usdc, A, U, offsetBps);
}

export interface LegacyMevOrbitSetup {
  pools: string[];
  orbit: [string, string, string];
  startPool: string;
}

export interface DualMevOrbitSetup {
  pools: string[];
  negOrbit: [string, string, string];
  posOrbit: [string, string, string];
  startPool: string;
}

function pickOffset(offsets: OrbitOffsets | undefined, idx: number, fallback: number): number {
  if (!offsets || offsets.length === 0) return fallback;
  const value = offsets[idx] ?? offsets[offsets.length - 1];
  return Number(value);
}

export async function setupLegacyMevOrbit(
  env: DeployCoreResult,
  opts?: { offsets?: OrbitOffsets }
): Promise<LegacyMevOrbitSetup> {
  const { factory, treasury, asset, usdc, router, assetAddr, usdcAddr } = env;
  await ensureNPools(factory, treasury, assetAddr, usdcAddr, 3);
  const allPools = await factory.getPools();
  const orbit = allPools.slice(0, 3) as [string, string, string];
  const offsets = opts?.offsets ?? [-500, -500, -500];

  for (let i = 0; i < orbit.length; i++) {
    await bootstrapIfNeeded(orbit[i], treasury, asset, usdc, pickOffset(offsets, i, -500));
  }

  await wireLegacyOrbit(treasury, router, orbit[0], orbit);

  return { pools: [...orbit], orbit, startPool: orbit[0] };
}

export async function setupDualMevOrbit(
  env: DeployCoreResult,
  opts?: {
    startWithNeg?: boolean;
    negOffsets?: OrbitOffsets;
    posOffsets?: OrbitOffsets;
  }
): Promise<DualMevOrbitSetup> {
  const { factory, treasury, asset, usdc, router, assetAddr, usdcAddr } = env;
  await ensureNPools(factory, treasury, assetAddr, usdcAddr, 6);
  const subset = (await factory.getPools()).slice(0, 6);
  if (subset.length < 6) throw new Error("setupDualMevOrbit requires 6 pools");

  const negOrbit = subset.slice(0, 3) as [string, string, string];
  const posOrbit = subset.slice(3, 6) as [string, string, string];

  const negOffsets = opts?.negOffsets ?? [-500, -500, -500];
  const posOffsets = opts?.posOffsets ?? [500, 500, 500];

  for (let i = 0; i < negOrbit.length; i++) {
    await bootstrapIfNeeded(negOrbit[i], treasury, asset, usdc, pickOffset(negOffsets, i, -500));
  }
  for (let i = 0; i < posOrbit.length; i++) {
    await bootstrapIfNeeded(posOrbit[i], treasury, asset, usdc, pickOffset(posOffsets, i, 500));
  }

  const startPool = negOrbit[0];
  await wireDualOrbit(
    treasury,
    router,
    startPool,
    negOrbit,
    posOrbit,
    opts?.startWithNeg ?? true
  );

  return { pools: subset, negOrbit, posOrbit, startPool };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Token helpers
 * ──────────────────────────────────────────────────────────────────────────── */

export async function getTokensFromPoolAddr(poolAddr: string) {
  const pool = (await ethers.getContractAt("LPPPool", poolAddr)) as LPPPool;
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

export async function approveSupplicator(access: LPPAccessManager, who: string, approved = true) {
  await (await access.setApprovedSupplicator(who, approved)).wait();
}

/** Runs a single-pool supplicate (permissioned). Approves router (fee) + pool (principal). */
export async function runSupplicate(params: {
  router: LPPRouter;
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
 * MEV path (3-hop MCV SWAP) — public, no supplicator role required
 * ──────────────────────────────────────────────────────────────────────────── */

/** Quote like a searcher: uses Router.getAmountsOutFromStart (no storage peeking) */
export async function mevQuote(router: LPPRouter, startPool: string, amountIn: bigint) {
  const q = await (router as any).getAmountsOutFromStart(startPool, amountIn);
  // q = [assetToUsdc(bool), orbit(address[3]), perHop(uint256[3]), total(uint256)]
  return {
    assetToUsdc: Boolean(q[0]),
    orbit: q[1] as string[],
    perHop: (q[2] as bigint[]).map((x: any) => BigInt(String(x))),
    total: BigInt(String(q[3])),
  };
}

/** Prepare approvals for a swap:
 *  - Router needs allowance to pull fees on tokenIn.
 *  - Each pool needs allowance to pull principal (amountIn) for its hop.
 */
export async function prepareSwapApprovals(params: {
  caller: any;
  router: LPPRouter;
  orbit: string[];
  tokenIn: TestERC20;
}) {
  const { caller, router, orbit, tokenIn } = params;
  await approveMax(tokenIn, caller, await router.getAddress());
  await approveMaxMany(tokenIn, caller, orbit);
}

/** Execute a 3-hop swap (MCV).
 *  - We first quote to know direction + tokenIn (so we don’t read custom storage)
 *  - Then do approvals and call router.swap(...)
 */
export async function runSwap(params: {
  router: LPPRouter;
  caller: any;               // signer
  startPool: string;
  amountIn: bigint;
  minTotalAmountOut?: bigint;
  to?: string;
  payer?: string;
}) {
  const { router, caller, startPool, amountIn } = params;
  const minTotalAmountOut = params.minTotalAmountOut ?? 0n;
  const to = params.to ?? caller.address;
  const payer = params.payer ?? caller.address;

  // Quote like a MEV
  const q = await mevQuote(router, startPool, amountIn);

  // Resolve tokenIn from the first pool in orbit using direction
  const { assetAddr, usdcAddr } = await getTokensFromPoolAddr(q.orbit[0]);
  const tokenInAddr = q.assetToUsdc ? assetAddr : usdcAddr;
  const tokenIn = (await ethers.getContractAt("TestERC20", tokenInAddr)) as TestERC20;

  // Approvals: router (fee) + each pool (principal)
  await prepareSwapApprovals({ caller, router, orbit: q.orbit, tokenIn });

  // Call the MEV-facing surface
  const tx = await (router.connect(caller) as any).swap({
    startPool,
    assetToUsdc: false,       // ignored if dual-orbit set; kept for legacy single-orbit
    amountIn,
    minTotalAmountOut,
    to,
    payer,
  });
  return await tx.wait();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Read helpers for tests
 * ──────────────────────────────────────────────────────────────────────────── */

export async function getReservesLike(pool: LPPPool) {
  const [rA, rU] = await Promise.all([pool.reserveAsset(), pool.reserveUsdc()]);
  return { reserveAsset: BigInt(rA.toString()), reserveUsdc: BigInt(rU.toString()) };
}