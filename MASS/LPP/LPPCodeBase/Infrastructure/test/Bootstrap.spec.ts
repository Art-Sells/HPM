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
  LPPMintHook,
} from "../typechain-types";

/* ---------------- math + price helpers ---------------- */

const Q96  = 1n << 96n;
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

async function allowPairViaTreasury(treasury: LPPTreasury, factory: LPPFactory, a: string, u: string) {
  await (await treasury.allowTokenViaTreasury(await factory.getAddress(), a, true)).wait();
  await (await treasury.allowTokenViaTreasury(await factory.getAddress(), u, true)).wait();
}

async function newPoolViaTreasuryWithTokens(
  treasury: LPPTreasury,
  factory: LPPFactory,
  assetAddr: string,
  usdcAddr: string
): Promise<LPPPool> {
  await allowPairViaTreasury(treasury, factory, assetAddr, usdcAddr);

  const tx = await (treasury as any).createPoolViaTreasury(
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

async function wireHookViaTreasury(
  treasury: LPPTreasury,
  factory: LPPFactory,
  pool: LPPPool,
  hook: LPPMintHook
) {
  const tx = await (treasury as any).setPoolHookViaTreasury(
    await factory.getAddress(),
    await pool.getAddress(),
    await hook.getAddress()
  );
  const rcpt = await tx.wait();
  await snapshotGasCost(rcpt!.gasUsed);
}

/** Use the 5-arg overload with offset bps */
async function bootstrapViaTreasury(
  treasury: LPPTreasury,
  hook: LPPMintHook,
  pool: LPPPool,
  amountAsset: bigint,
  amountUsdc: bigint,
  offsetBps: bigint
) {
  const fn = (treasury as any)["bootstrapViaTreasury(address,address,uint256,uint256,int256)"];
  const tx = await fn(
    await hook.getAddress(),
    await pool.getAddress(),
    amountAsset,
    amountUsdc,
    offsetBps
  );
  const rcpt = await tx.wait();
  await snapshotGasCost(rcpt!.gasUsed);
}

/** Impersonate the Treasury (contract) as signer */
async function asTreasurySigner(treasury: LPPTreasury) {
  const tAddr = await treasury.getAddress();
  await ethers.provider.send("hardhat_impersonateAccount", [tAddr]);
  await ethers.provider.send("hardhat_setBalance", [tAddr, "0x56BC75E2D63100000"]); // 100 ETH
  return ethers.getSigner(tAddr);
}

/** Fund Treasury with tokens and approve Hook to pull them during bootstrap */
async function fundTreasuryAndApproveHook(
  env: { deployer: any; treasury: LPPTreasury; hook: LPPMintHook; asset: any; usdc: any },
  amountA: bigint,
  amountU: bigint
) {
  const tAddr = await env.treasury.getAddress();

  // Mint balances to treasury (deployer is the minter)
  if (amountA > 0n) await (await env.asset.connect(env.deployer).mint(tAddr, amountA)).wait();
  if (amountU > 0n) await (await env.usdc.connect(env.deployer).mint(tAddr, amountU)).wait();

  // Approve hook from treasury address (impersonated)
  const tSigner = await asTreasurySigner(env.treasury);
  await (await env.asset.connect(tSigner).approve(await env.hook.getAddress(), ethers.MaxUint256)).wait();
  await (await env.usdc.connect(tSigner).approve(await env.hook.getAddress(), ethers.MaxUint256)).wait();
}

/* ---------------- tests ---------------- */

describe("Bootstrap", () => {
  it("Factory + pool deployed & initialized", async () => {
    const e = await deployCore();
    await snapshotGasCost(e.factory);

    expect({
      factory: await addr(e.factory),
      pool: await addr(e.pool),
      reserves: {
        asset: (await (e.pool as any).reserveAsset()).toString(),
        usdc:  (await (e.pool as any).reserveUsdc()).toString(),
      },
    }).to.matchSnapshot();

    await snapshotPriceDetail(e.pool, "Baseline price fields");
  });

  it("cannot bootstrap twice (idempotency enforced)", async () => {
    const e = await deployCore();
    await expect(
      (e.treasury as any)["bootstrapViaTreasury(address,address,uint256,uint256)"](
        await e.hook.getAddress(),
        await e.pool.getAddress(),
        1n,
        1n
      )
    ).to.be.revertedWith("already init");
  });

  it("only Treasury owner can call bootstrapViaTreasury", async () => {
    const e = await deployCore();

    const freshPool = await newPoolViaTreasuryWithTokens(
      e.treasury,
      e.factory,
      await e.asset.getAddress(),
      await e.usdc.getAddress()
    );
    await wireHookViaTreasury(e.treasury, e.factory, freshPool, e.hook);

    const [, notOwner] = await ethers.getSigners();
    await expect(
      (e.treasury.connect(notOwner) as any)["bootstrapViaTreasury(address,address,uint256,uint256)"](
        await e.hook.getAddress(),
        await freshPool.getAddress(),
        1n,
        1n
      )
    ).to.be.revertedWith("not owner");
  });

  it("bootstrap reverts if hook is not wired yet", async () => {
    const e = await deployCore();

    // Fresh pool with REAL tokens but no hook wired
    const pool2 = await newPoolViaTreasuryWithTokens(
      e.treasury, e.factory,
      await e.asset.getAddress(),
      await e.usdc.getAddress()
    );

    // Ensure token path doesn't short-circuit: fund + approve treasury→hook
    await fundTreasuryAndApproveHook(e, ethers.parseEther("10"), ethers.parseEther("10"));

    await expect(
      (e.treasury as any)["bootstrapViaTreasury(address,address,uint256,uint256)"](
        await e.hook.getAddress(),
        await pool2.getAddress(),
        10n,
        10n
      )
    ).to.be.revertedWith("only hook");
  });

  it("bootstrap with zero amounts is rejected", async () => {
    const e = await deployCore();

    const pool2 = await newPoolViaTreasuryWithTokens(
      e.treasury, e.factory,
      await e.asset.getAddress(),
      await e.usdc.getAddress()
    );
    await wireHookViaTreasury(e.treasury, e.factory, pool2, e.hook);

    // Avoid ERC20 short-circuit; then assert the zero guard
    await fundTreasuryAndApproveHook(e, ethers.parseEther("10"), ethers.parseEther("10"));

    await expect(
      (e.treasury as any)["bootstrapViaTreasury(address,address,uint256,uint256)"](
        await e.hook.getAddress(),
        await pool2.getAddress(),
        0n,
        10n
      )
    ).to.be.revertedWith("zero");

    await expect(
      (e.treasury as any)["bootstrapViaTreasury(address,address,uint256,uint256)"](
        await e.hook.getAddress(),
        await pool2.getAddress(),
        10n,
        0n
      )
    ).to.be.revertedWith("zero");
  });

  it("post-bootstrap reserves are the pool's accounting truth", async () => {
    const e = await deployCore();
    await snapshotParity(e.pool, "Parity after bootstrap");
    await snapshotPriceDetail(e.pool, "Price fields after bootstrap");
  });

  it("after bootstrap, first mint increases reserves and credits LP-MCV", async () => {
    const e = await deployCore();

    const before = {
      resA: (await (e.pool as any).reserveAsset()) as bigint,
      resU: (await (e.pool as any).reserveUsdc())  as bigint,
    };

    const tx = await (e.hook as any).mintWithRebate({
      pool: await e.pool.getAddress(),
      to: await e.deployer.getAddress(),
      amountAssetDesired: ethers.parseEther("1"),
      amountUsdcDesired:  ethers.parseEther("1"),
      data: "0x",
    });
    const r = await tx.wait();
    await snapshotGasCost(r!.gasUsed);

    const after = {
      resA: (await (e.pool as any).reserveAsset()) as bigint,
      resU: (await (e.pool as any).reserveUsdc())  as bigint,
    };

    const dA = after.resA - before.resA;
    const dU = after.resU - before.resU;
    expect(dA).to.be.gt(0n);
    expect(dU).to.be.gt(0n);

    expect({
      pool: await addr(e.pool),
      deltas: { asset: dA.toString(), usdc: dU.toString() },
      reservesAfter: { asset: after.resA.toString(), usdc: after.resU.toString() },
    }).to.matchSnapshot("Mint — DELTAS & RESERVES");

    await snapshotPriceDetail(e.pool, "Mint — PRICE FIELDS AFTER");
  });
});

describe("Offset bootstrap seeding", () => {
  it("seeds three pools off-center and snapshots drift (bps)", async () => {
    const e = await deployCore();

    await snapshotPriceDetail(e.pool, "Offset seed — baseline (0 bps)");

    const assetAddr = await e.asset.getAddress();
    const usdcAddr  = await e.usdc.getAddress();

    const poolA = await newPoolViaTreasuryWithTokens(e.treasury, e.factory, assetAddr, usdcAddr);
    await wireHookViaTreasury(e.treasury, e.factory, poolA, e.hook);

    const poolB = await newPoolViaTreasuryWithTokens(e.treasury, e.factory, assetAddr, usdcAddr);
    await wireHookViaTreasury(e.treasury, e.factory, poolB, e.hook);

    const poolC = await newPoolViaTreasuryWithTokens(e.treasury, e.factory, assetAddr, usdcAddr);
    await wireHookViaTreasury(e.treasury, e.factory, poolC, e.hook);

    const amtA = ethers.parseEther("100");
    const amtU = ethers.parseEther("100");

    // Fund once with enough for all three boots
    await fundTreasuryAndApproveHook(e, amtA * 3n, amtU * 3n);

    await bootstrapViaTreasury(e.treasury, e.hook, poolA, amtA, amtU, -10n);
    await bootstrapViaTreasury(e.treasury, e.hook, poolB, amtA, amtU,  -5n);
    await bootstrapViaTreasury(e.treasury, e.hook, poolC, amtA, amtU,  15n);

    await snapshotPriceDetail(poolA, "Offset seed — Pool A (-10 bps)");
    await snapshotPriceDetail(poolB, "Offset seed — Pool B (-5 bps)");
    await snapshotPriceDetail(poolC, "Offset seed — Pool C (+15 bps)");
  });
});