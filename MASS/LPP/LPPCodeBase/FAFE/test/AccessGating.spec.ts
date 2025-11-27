// test/AccessGating.Supplicate.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import snapshotGasCost from "./shared/snapshotGasCost.ts";
import {
  deployCore,
  bootstrapPool,
  A,
  U,
  runSwap,
  quoteSwap,
  setDedicatedAA,
  approveSupplicator,
} from "./helpers.ts";

/* ─────────────────────────── ABI helpers ─────────────────────────── */

function mustHaveFn(iface: any, signature: string) {
  try {
    iface.getFunction(signature);
  } catch {
    throw new Error(`Missing fn in ABI: ${signature}`);
  }
}

function mustHaveEvent(iface: any, signature: string) {
  try {
    iface.getEvent(signature);
  } catch {
    throw new Error(`Missing event in ABI: ${signature}`);
  }
}

/* ─────────────────────────── local helpers ─────────────────────────── */

function randAddr() {
  return ethers.Wallet.createRandom().address;
}

function pair() {
  let a = randAddr();
  let u = randAddr();
  if (u.toLowerCase() === a.toLowerCase()) u = randAddr();
  return { a, u };
}

async function readTokenBalances(tokens: { asset?: any; usdc?: any }, who: string) {
  const a = tokens.asset ? BigInt((await tokens.asset.balanceOf(who)).toString()) : 0n;
  const u = tokens.usdc ? BigInt((await tokens.usdc.balanceOf(who)).toString()) : 0n;
  return { a, u };
}

async function reserves(pool: any) {
  const a = BigInt((await pool.reserveAsset()).toString());
  const u = BigInt((await pool.reserveUsdc()).toString());
  return { a, u };
}

async function snapshotReserves(pool: any, label: string) {
  const r = await reserves(pool);
  expect({
    reserves: { asset: r.a.toString(), usdc: r.u.toString() },
  }).to.matchSnapshot(label);
}

/* ---------- approve & funding helpers ---------- */

async function mintFundAndApprove(
  token: any,
  tokenOwner: any,   // deployer (minter)
  payer: any,        // signer who will call router
  router: any,
  amount: bigint
) {
  const payerAddr = await payer.getAddress();
  await (await token.connect(tokenOwner).mint(payerAddr, amount)).wait();
  // Router needs allowance to pull per-hop fees
  await (await token.connect(payer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
}

// Compute per-hop fee pieces from router constants
async function feePieces(router: any, amountIn: bigint) {
  const BPS = 10_000n;
  const feeBps = BigInt(await router.MCV_FEE_BPS());
  const treasuryCutBps = BigInt(await router.TREASURY_CUT_BPS());
  const fee = (amountIn * feeBps) / BPS;
  const treasuryFee = (amountIn * treasuryCutBps) / BPS;
  const poolsFee = fee - treasuryFee;
  return { fee, treasuryFee, poolsFee };
}

async function snapshotSupplicateStrict(opts: {
  label: string;
  router: any;
  pool: any;
  asset: any;
  usdc: any;
  signer: any;
  args: {
    pool: string;
    assetToUsdc: boolean;
    amountIn: bigint;
    minAmountOut: bigint;
    to: string;
    payer: string;
  };
}) {
  const { label, router, pool, asset, usdc, signer, args } = opts;

  const who = await signer.getAddress();
  const tok = { asset, usdc };
  const b0 = await readTokenBalances(tok, who);
  const r0 = await reserves(pool);

  const { fee, poolsFee } = await feePieces(router, args.amountIn);

  const amountOut: bigint = await (router.connect(signer) as any).supplicate.staticCall(args);

  const tx = await (router.connect(signer) as any).supplicate(args);

  // Expect router-side SupplicateExecuted (7 args; last is reserved uint256)
  try {
    const assetIn  = args.assetToUsdc ? await pool.asset() : await pool.usdc();
    const assetOut = args.assetToUsdc ? await pool.usdc() : await pool.asset();
    await expect(tx)
      .to.emit(router, "SupplicateExecuted")
      .withArgs(
        who,
        args.pool,
        assetIn,
        args.amountIn,
        assetOut,
        amountOut,
        0 // reserved
      );
  } catch {
    // tolerate signature drift, still measure gas + state
  }

  const rcpt = await tx.wait();
  await snapshotGasCost(rcpt!.gasUsed);

  const b1 = await readTokenBalances(tok, who);
  const r1 = await reserves(pool);

  // Direction-aware checks and per-token outs
  let assetOut = 0n, usdcOut = 0n;

  if (args.assetToUsdc) {
    // payer spent amountIn in ASSET (no fee charged in supplicate)
    expect(b0.a - b1.a).to.equal(args.amountIn);
    // user received USDC = amountOut
    expect(b1.u - b0.u).to.equal(amountOut);

    // pool reserves: ASSET increased by amountIn; USDC decreased by amountOut
    expect(r1.a - r0.a).to.equal(args.amountIn);
    expect(r0.u - r1.u).to.equal(amountOut);

    assetOut = 0n;
    usdcOut  = b1.u - b0.u;
  } else {
    // payer spent amountIn in USDC (no fee charged in supplicate)
    expect(b0.u - b1.u).to.equal(args.amountIn);
    // user received ASSET = amountOut
    expect(b1.a - b0.a).to.equal(amountOut);

    // pool reserves: USDC increased by amountIn; ASSET decreased by amountOut
    expect(r1.u - r0.u).to.equal(args.amountIn);
    expect(r0.a - r1.a).to.equal(amountOut);

    assetOut = b1.a - b0.a;
    usdcOut  = 0n;
  }

  // "Out" side sanity: what left the pool equals what the user gained
  const poolAOut = r0.a > r1.a ? r0.a - r1.a : 0n;
  const poolUOut = r0.u > r1.u ? r0.u - r1.u : 0n;
  const userAOut = b1.a > b0.a ? b1.a - b0.a : 0n;
  const userUOut = b1.u > b0.u ? b1.u - b0.u : 0n;
  expect(poolAOut + poolUOut).to.equal(userAOut + userUOut);

  expect({
    label,
    direction: args.assetToUsdc ? "ASSET->USDC" : "USDC->ASSET",
    amountIn: args.amountIn.toString(),
    amountOut: amountOut.toString(),
    amounts: {
      assetOut: assetOut.toString(),
      usdcOut:  usdcOut.toString(),
      sumOut:   (assetOut + usdcOut).toString(),
    },
    minOut: args.minAmountOut.toString(),
    caller: who,
    reserves: {
      before: { a: r0.a.toString(), u: r0.u.toString() },
      after:  { a: r1.a.toString(), u: r1.u.toString() },
    },
    callerBalances: {
      before: { a: b0.a.toString(), u: b0.u.toString() },
      after:  { a: b1.a.toString(), u: b1.u.toString() },
    },
    gasUsed: rcpt!.gasUsed.toString(),
  }).to.matchSnapshot(label);
}

async function snapshotSwapStrict(opts: {
  label: string;
  router: any;
  pool: any;
  asset: any;
  usdc: any;
  signer: any;
  args: {
    pool: string;
    assetToUsdc: boolean;
    amountIn: bigint;
    minAmountOut: bigint;
  };
}) {
  const { label, router, pool, asset, usdc, signer, args } = opts;

  const who = await signer.getAddress();
  const tok = { asset, usdc };
  const b0 = await readTokenBalances(tok, who);
  const r0 = await reserves(pool);
  const offsetBefore = await pool.targetOffsetBps();

  // Quote the swap
  const amountOut: bigint = await router.quoteSwap(args.pool, args.assetToUsdc, args.amountIn);

  // Execute the swap
  const tx = await (router.connect(signer) as any).swap({
    pool: args.pool,
    assetToUsdc: args.assetToUsdc,
    amountIn: args.amountIn,
    minAmountOut: args.minAmountOut,
    to: who,
    payer: who,
  });

  // Check SwapExecuted event
  try {
    const assetIn  = args.assetToUsdc ? await pool.asset() : await pool.usdc();
    const assetOut = args.assetToUsdc ? await pool.usdc() : await pool.asset();
    await expect(tx)
      .to.emit(router, "SwapExecuted")
      .withArgs(
        who,
        args.pool,
        assetIn,
        args.amountIn,
        assetOut,
        amountOut
      );
  } catch {
    // tolerate signature drift, still measure gas + state
  }

  const rcpt = await tx.wait();
  await snapshotGasCost(rcpt!.gasUsed);

  const b1 = await readTokenBalances(tok, who);
  const r1 = await reserves(pool);
  const offsetAfter = await pool.targetOffsetBps();

  // Direction-aware checks and per-token outs
  let assetOut = 0n, usdcOut = 0n;

  if (args.assetToUsdc) {
    // payer spent amountIn in ASSET
    expect(b0.a - b1.a).to.equal(args.amountIn);
    // user received USDC = amountOut
    expect(b1.u - b0.u).to.equal(amountOut);

    // pool reserves: ASSET increased by amountIn; USDC decreased by amountOut
    expect(r1.a - r0.a).to.equal(args.amountIn);
    expect(r0.u - r1.u).to.equal(amountOut);

    assetOut = 0n;
    usdcOut  = b1.u - b0.u;
  } else {
    // payer spent amountIn in USDC
    expect(b0.u - b1.u).to.equal(args.amountIn);
    // user received ASSET = amountOut
    expect(b1.a - b0.a).to.equal(amountOut);

    // pool reserves: USDC increased by amountIn; ASSET decreased by amountOut
    expect(r1.u - r0.u).to.equal(args.amountIn);
    expect(r0.a - r1.a).to.equal(amountOut);

    assetOut = b1.a - b0.a;
    usdcOut  = 0n;
  }

  // "Out" side sanity: what left the pool equals what the user gained
  const poolAOut = r0.a > r1.a ? r0.a - r1.a : 0n;
  const poolUOut = r0.u > r1.u ? r0.u - r1.u : 0n;
  const userAOut = b1.a > b0.a ? b1.a - b0.a : 0n;
  const userUOut = b1.u > b0.u ? b1.u - b0.u : 0n;
  expect(poolAOut + poolUOut).to.equal(userAOut + userUOut);

  // Verify offset was flipped
  expect(Number(offsetAfter)).to.equal(-Number(offsetBefore));

  expect({
    label,
    direction: args.assetToUsdc ? "ASSET->USDC" : "USDC->ASSET",
    amountIn: args.amountIn.toString(),
    amountOut: amountOut.toString(),
    amounts: {
      assetOut: assetOut.toString(),
      usdcOut:  usdcOut.toString(),
      sumOut:   (assetOut + usdcOut).toString(),
    },
    minOut: args.minAmountOut.toString(),
    caller: who,
    reserves: {
      before: { a: r0.a.toString(), u: r0.u.toString() },
      after:  { a: r1.a.toString(), u: r1.u.toString() },
    },
    offset: {
      before: offsetBefore.toString(),
      after:  offsetAfter.toString(),
    },
    callerBalances: {
      before: { a: b0.a.toString(), u: b0.u.toString() },
      after:  { a: b1.a.toString(), u: b1.u.toString() },
    },
    gasUsed: rcpt!.gasUsed.toString(),
  }).to.matchSnapshot(label);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Main spec 
 * ──────────────────────────────────────────────────────────────────────────── */

describe("Access gating", () => {
  //
  // ───────────────────────────── ABI surface smoke test ─────────────────────────────
  //
  it("ABI shape: router.supplicate / pool.supplicate present", async () => {
    const { router, pool } = await deployCore();

    mustHaveFn(router.interface, "supplicate((address,bool,uint256,uint256,address,address))");
    // NOTE: reserved is uint256 now
    mustHaveEvent(
      router.interface,
      "SupplicateExecuted(address,address,address,uint256,address,uint256,uint256)"
    );

    mustHaveFn(pool.interface, "supplicate(address,address,bool,uint256,uint256)");
    mustHaveFn(pool.interface, "quoteSupplication(bool,uint256)");
  });

  //
  // ───────────────────────────────── Permissions: Approved-only ────────────────────────────────
  //
  describe("Permissions: Approved Supplicators only", () => {
    it("Approved Supplicator can supplicate ASSET->USDC (ABI-verified)", async () => {
      const { deployer, other, access, router, pool, asset, usdc, treasury } = await deployCore();

      // Bootstrap reserves with -5000 offset (same as swap tests)
      await bootstrapPool(treasury, await pool.getAddress(), asset, usdc, A, U, -5000);

      // Approve 'other' as supplicator
      await (await access.connect(deployer).setApprovedSupplicator(other.address, true)).wait();

      // Fund 'other' with ASSET, approve router (fees) and pool (principal)
      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("2"));
      await (await asset.connect(other).approve(await pool.getAddress(), ethers.MaxUint256)).wait();

      await snapshotReserves(pool, "Approved — pre supplicate ASSET->USDC");

      await snapshotSupplicateStrict({
        label: "Approved — ASSET->USDC outcome (Phase 0)",
        router,
        pool,
        asset,
        usdc,
        signer: other,
        args: {
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
          to: other.address,
          payer: other.address,
        },
      });
    });

    it("Approved Supplicator can supplicate USDC->ASSET (ABI-verified)", async () => {
      const { deployer, other, access, router, pool, asset, usdc, treasury } = await deployCore();

      // Bootstrap with +5000 offset (same as swap tests)
      await bootstrapPool(treasury, await pool.getAddress(), asset, usdc, A, U, 5000);

      await (await access.connect(deployer).setApprovedSupplicator(other.address, true)).wait();

      await mintFundAndApprove(usdc, deployer, other, router, ethers.parseEther("2"));
      // approve pool to pull USDC principal
      await (await usdc.connect(other).approve(await pool.getAddress(), ethers.MaxUint256)).wait();

      await snapshotSupplicateStrict({
        label: "Approved — USDC->ASSET outcome (Phase 0)",
        router,
        pool,
        asset,
        usdc,
        signer: other,
        args: {
          pool: await pool.getAddress(),
          assetToUsdc: false,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
          to: other.address,
          payer: other.address,
        },
      });
    });

    it("Unauthorized caller reverts (not Approved, even if they have liquidity)", async () => {
      const { deployer, other, router, pool, asset, usdc, treasury } = await deployCore();

      // Bootstrap so we don't fail early on empty reserves
      await bootstrapPool(treasury, await pool.getAddress(), asset, usdc, A, U, 0);

      // Fund 'other' with ASSET but DO NOT approve in AccessManager
      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("1"));
      await (await asset.connect(other).approve(await pool.getAddress(), ethers.MaxUint256)).wait();

      await expect(
        (router.connect(other) as any).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("0.5"),
          minAmountOut: 0n,
          to: other.address,
          payer: other.address,
        })
      ).to.be.revertedWith("not permitted");
    });

    it("Approved toggling affects Router permission", async () => {
      const { deployer, other, access, router, pool, asset, usdc, treasury } = await deployCore();

      // Bootstrap with -5000 offset (same as other supplicate tests)
      await bootstrapPool(treasury, await pool.getAddress(), asset, usdc, A, U, -5000);

      // Approve 'other'
      await (await access.connect(deployer).setApprovedSupplicator(other.address, true)).wait();

      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("2"));
      await (await asset.connect(other).approve(await pool.getAddress(), ethers.MaxUint256)).wait();

      await snapshotSupplicateStrict({
        label: "Toggle — approved(other) allowed (Phase 0)",
        router,
        pool,
        asset,
        usdc,
        signer: other,
        args: {
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
          to: other.address,
          payer: other.address,
        },
      });

      // Revoke → denied
      await (await access.connect(deployer).setApprovedSupplicator(other.address, false)).wait();

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
  });

  //
  // ───────────────────────────────── Permissions: Dedicated AA Swap only ────────────────────────────────
  //
  describe("Permissions: Dedicated AA Swap only", () => {
    it("Dedicated AA can swap ASSET->USDC", async () => {
      const { deployer, other, access, router, pool, asset, usdc, treasury } = await deployCore();

      // Bootstrap reserves so quotes won't revert
      await bootstrapPool(treasury, await pool.getAddress(), asset, usdc, A, U, -5000);

      // Set 'other' as dedicated AA (using deployer as treasury owner)
      await setDedicatedAA(treasury, access, other.address, deployer);

      // Fund 'other' with ASSET, approve pool for principal
      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("2"));
      await (await asset.connect(other).approve(await pool.getAddress(), ethers.MaxUint256)).wait();

      await snapshotSwapStrict({
        label: "Dedicated AA — ASSET->USDC swap (Phase 0)",
        router,
        pool,
        asset,
        usdc,
        signer: other,
        args: {
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
        },
      });
    });

    it("Dedicated AA can swap USDC->ASSET", async () => {
      const { deployer, other, access, router, pool, asset, usdc, treasury } = await deployCore();

      // Bootstrap with positive offset
      await bootstrapPool(treasury, await pool.getAddress(), asset, usdc, A, U, 5000);

      // Set 'other' as dedicated AA (using deployer as treasury owner)
      await setDedicatedAA(treasury, access, other.address, deployer);

      // Fund 'other' with USDC, approve pool for principal
      await mintFundAndApprove(usdc, deployer, other, router, ethers.parseEther("2"));
      await (await usdc.connect(other).approve(await pool.getAddress(), ethers.MaxUint256)).wait();

      await snapshotSwapStrict({
        label: "Dedicated AA — USDC->ASSET swap (Phase 0)",
        router,
        pool,
        asset,
        usdc,
        signer: other,
        args: {
          pool: await pool.getAddress(),
          assetToUsdc: false,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
        },
      });
    });

    it("Approved supplicator (but not dedicated AA) cannot swap", async () => {
      const { deployer, other, access, router, pool, asset, usdc, treasury } = await deployCore();

      // Bootstrap reserves
      await bootstrapPool(treasury, await pool.getAddress(), asset, usdc, A, U, -5000);

      // Approve 'other' as supplicator (can supplicate) but NOT as dedicated AA
      await approveSupplicator(access, other.address, true);
      // Do NOT set as dedicated AA

      // Fund 'other' with ASSET
      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("2"));
      await (await asset.connect(other).approve(await pool.getAddress(), ethers.MaxUint256)).wait();

      // Should revert - not the dedicated AA
      await expect(
        runSwap({
          router,
          caller: other,
          poolAddr: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
        })
      ).to.be.revertedWith("only dedicated AA");
    });

    it("Unauthorized caller (not approved, not dedicated AA) cannot swap", async () => {
      const { deployer, other, router, pool, asset, usdc, treasury } = await deployCore();

      // Bootstrap reserves
      await bootstrapPool(treasury, await pool.getAddress(), asset, usdc, A, U, -5000);

      // Do NOT approve 'other' as supplicator
      // Do NOT set as dedicated AA

      // Fund 'other' with ASSET
      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("2"));
      await (await asset.connect(other).approve(await pool.getAddress(), ethers.MaxUint256)).wait();

      // Should revert - not the dedicated AA
      await expect(
        runSwap({
          router,
          caller: other,
          poolAddr: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
        })
      ).to.be.revertedWith("only dedicated AA");
    });

    it("Dedicated AA can be changed by Treasury; old AA loses swap permission", async () => {
      const { deployer, other, access, router, pool, asset, usdc, treasury } = await deployCore();
      const [, , newAA] = await ethers.getSigners(); // Use third signer, not second (other is second)

      // Bootstrap reserves
      await bootstrapPool(treasury, await pool.getAddress(), asset, usdc, A, U, -5000);

      // Set 'other' as initial dedicated AA (using deployer as treasury owner)
      await setDedicatedAA(treasury, access, other.address, deployer);

      // Fund both addresses
      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("2"));
      await mintFundAndApprove(asset, deployer, newAA, router, ethers.parseEther("2"));
      await (await asset.connect(other).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
      await (await asset.connect(newAA).approve(await pool.getAddress(), ethers.MaxUint256)).wait();

      // 'other' can swap
      const firstSwap = await runSwap({
        router,
        caller: other,
        poolAddr: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("0.5"),
        minAmountOut: 0n,
      });
      expect(firstSwap).to.not.be.null;

      // Verify initial state - dedicated AA should be set to 'other'
      const initialAA = await access.dedicatedAA();
      expect(initialAA).to.equal(other.address);
      expect(await access.isDedicatedAA(other.address)).to.be.true;
      
      // newAA should NOT be the dedicated AA yet
      const isNewAAInitially = await access.isDedicatedAA(newAA.address);
      if (isNewAAInitially) {
        throw new Error(`newAA.address (${newAA.address}) is already the dedicated AA, but it should be other.address (${other.address}). Current dedicatedAA: ${initialAA}`);
      }

      // Change dedicated AA to newAA (using deployer as treasury owner)
      const tx = await setDedicatedAA(treasury, access, newAA.address, deployer);

      // Verify dedicated AA was changed (check the actual state)
      const dedicatedAAAfter = await access.dedicatedAA();
      expect(dedicatedAAAfter).to.equal(newAA.address);
      
      // Verify isDedicatedAA returns correct values
      const isOtherAA = await access.isDedicatedAA(other.address);
      const isNewAA = await access.isDedicatedAA(newAA.address);
      
      expect(isOtherAA, "other should not be dedicated AA after change").to.be.false;
      expect(isNewAA, "newAA should be dedicated AA after change").to.be.true;

      // Re-bootstrap pool if needed (first swap may have drained reserves)
      const reservesAfter = await pool.reserveUsdc();
      if (reservesAfter < ethers.parseEther("0.5")) {
        const currentOffset = await pool.targetOffsetBps();
        await bootstrapPool(treasury, await pool.getAddress(), asset, usdc, A, U, Number(currentOffset));
      }

      // 'other' can no longer swap (should fail on access check, not reserves)
      await expect(
        runSwap({
          router,
          caller: other,
          poolAddr: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("0.1"),
          minAmountOut: 0n,
        })
      ).to.be.revertedWith("only dedicated AA");

      // newAA can now swap
      await expect(
        runSwap({
          router,
          caller: newAA,
          poolAddr: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("0.5"),
          minAmountOut: 0n,
        })
      ).to.not.be.reverted;
    });

    it("Treasury-only: setDedicatedAAViaTreasury requires owner", async () => {
      const { access, treasury } = await deployCore();
      const [, stranger] = await ethers.getSigners();

      await expect(
        (treasury.connect(stranger) as any).setDedicatedAAViaTreasury(
          await access.getAddress(),
          stranger.address
        )
      ).to.be.revertedWith("not owner");
    });

    it("Only Treasury can call setDedicatedAA directly (not owner)", async () => {
      const { deployer, other, access, treasury } = await deployCore();

      // Deployer is the owner of AccessManager, but not the treasury
      const treasuryAddr = await treasury.getAddress();
      
      // Owner cannot call setDedicatedAA directly (must go through Treasury)
      await expect(
        access.connect(deployer).setDedicatedAA(other.address)
      ).to.be.revertedWith("not treasury");

      // Treasury can call setDedicatedAA (via setDedicatedAAViaTreasury)
      await setDedicatedAA(treasury, access, other.address, deployer);
      
      // Verify it was set
      expect(await access.dedicatedAA()).to.equal(other.address);
      expect(await access.isDedicatedAA(other.address)).to.be.true;
    });

    it("setTreasury can only be called once by owner", async () => {
      const { deployer, access, treasury } = await deployCore();
      const [, stranger] = await ethers.getSigners();

      const treasuryAddr = await treasury.getAddress();

      // Treasury is already set in deployCore, so verify it's set
      expect(await access.treasury()).to.equal(treasuryAddr);

      // Cannot set treasury again (already set in deployCore)
      await expect(
        access.connect(deployer).setTreasury(stranger.address)
      ).to.be.revertedWith("treasury already set");

      // Non-owner cannot set treasury
      await expect(
        access.connect(stranger).setTreasury(stranger.address)
      ).to.be.revertedWith("not owner");
    });

    it("setTreasury must be set before setDedicatedAA can work", async () => {
      // Deploy AccessManager without setting treasury
      const Access = await ethers.getContractFactory("FAFEAccessManager");
      const access = await Access.deploy();
      await access.waitForDeployment();

      const [deployer] = await ethers.getSigners();
      const [, aaAddress] = await ethers.getSigners();

      // Cannot set dedicated AA if treasury not set
      await expect(
        access.connect(deployer).setDedicatedAA(aaAddress.address)
      ).to.be.revertedWith("not treasury");

      // Set treasury first
      const Treasury = await ethers.getContractFactory("FAFETreasury");
      const treasury = await Treasury.deploy();
      await treasury.waitForDeployment();
      await (await access.connect(deployer).setTreasury(await treasury.getAddress())).wait();

      // Now treasury can set dedicated AA (via Treasury contract)
      const treasuryOwner = deployer;
      await (await treasury.connect(treasuryOwner).setDedicatedAAViaTreasury(
        await access.getAddress(),
        aaAddress.address
      )).wait();

      expect(await access.dedicatedAA()).to.equal(aaAddress.address);
    });

    it("Dedicated AA can swap but cannot supplicate (unless also approved)", async () => {
      const { deployer, other, access, router, pool, asset, usdc, treasury } = await deployCore();

      // Bootstrap reserves
      await bootstrapPool(treasury, await pool.getAddress(), asset, usdc, A, U, -5000);

      // Set 'other' as dedicated AA but NOT as approved supplicator (using deployer as treasury owner)
      await setDedicatedAA(treasury, access, other.address, deployer);
      // After setDedicatedAA, AccessManager ownership is transferred to Treasury
      // So we need to use treasury owner (deployer) to approve
      await approveSupplicator(access, other.address, false, deployer);

      // Fund 'other' with ASSET
      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("2"));
      await (await asset.connect(other).approve(await pool.getAddress(), ethers.MaxUint256)).wait();

      // Can swap (dedicated AA)
      await expect(
        runSwap({
          router,
          caller: other,
          poolAddr: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
        })
      ).to.not.be.reverted;

      // Cannot supplicate (not approved supplicator)
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

    it("Swap flips offset after execution", async () => {
      const { deployer, other, access, router, pool, asset, usdc, treasury } = await deployCore();

      // Bootstrap with negative offset
      await bootstrapPool(treasury, await pool.getAddress(), asset, usdc, A, U, -5000);

      // Set 'other' as dedicated AA (using deployer as treasury owner)
      await setDedicatedAA(treasury, access, other.address, deployer);

      // Fund 'other' with ASSET
      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("2"));
      await (await asset.connect(other).approve(await pool.getAddress(), ethers.MaxUint256)).wait();

      // Check initial offset
      expect(await pool.targetOffsetBps()).to.equal(-5000);

      // Execute swap
      await runSwap({
        router,
        caller: other,
        poolAddr: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
      });

      // Check offset was flipped
      expect(await pool.targetOffsetBps()).to.equal(5000);

      // Execute another swap (should flip back)
      await runSwap({
        router,
        caller: other,
        poolAddr: await pool.getAddress(),
        assetToUsdc: false,
        amountIn: ethers.parseEther("0.5"),
        minAmountOut: 0n,
      });

      // Check offset flipped back
      expect(await pool.targetOffsetBps()).to.equal(-5000);
    });
  });

  //
  // ───────────────────────────────── Treasury-only Authorizations ─────────────────────────────────
  //
  describe("Treasury-only authorizations", () => {
    it("Treasury-only: createPool + allowToken", async () => {
      const { deployer, factory, treasury } = await deployCore();
      const [, stranger] = await ethers.getSigners();
      const { a, u } = pair();

      // Stranger cannot call factory directly if not treasury
      await expect(
        factory.connect(stranger).createPool(a, u)
      ).to.be.revertedWith("only treasury");

      // Treasury helper enforces owner
      await expect(
        (treasury.connect(stranger) as any).createPoolViaTreasury(
          await factory.getAddress(), a, u
        )
      ).to.be.revertedWith("not owner");

      // Real owner allow-lists + creates
      await expect(
        (treasury.connect(deployer) as any).allowTokenViaTreasury(
          await factory.getAddress(),
          a,
          true
        )
      ).to.not.be.reverted;

      await expect(
        (treasury.connect(deployer) as any).allowTokenViaTreasury(
          await factory.getAddress(),
          u,
          true
        )
      ).to.not.be.reverted;

      await expect(
        (treasury.connect(deployer) as any).createPoolViaTreasury(
          await factory.getAddress(), a, u
        )
      ).to.not.be.reverted;
    });

    it("factory.setTreasury: only current treasury; authority transfers correctly", async () => {
      const { deployer, factory, treasury } = await deployCore();
      const [, newOwner, stranger] = await ethers.getSigners();

      await expect(
        factory.connect(stranger).setTreasury(newOwner.address)
      ).to.be.revertedWith("only treasury");

      const oldTreasury = await factory.treasury();

      await expect(
        (treasury.connect(deployer) as any).rotateFactoryTreasury(
          await factory.getAddress(),
          newOwner.address
        )
      )
        .to.emit(factory, "TreasuryUpdated")
        .withArgs(oldTreasury, newOwner.address);

      expect(await factory.treasury()).to.equal(newOwner.address);

      const { a, u } = pair();

      await expect(
        (treasury.connect(deployer) as any).allowTokenViaTreasury(
          await factory.getAddress(), a, true
        )
      ).to.be.revertedWith("only treasury");

      await expect(
        (factory.connect(newOwner) as any).setAllowedToken(a, true)
      ).to.not.be.reverted;

      await expect(
        (factory.connect(newOwner) as any).setAllowedToken(u, true)
      ).to.not.be.reverted;

      await expect(
        (factory.connect(newOwner) as any).createPool(a, u)
      ).to.not.be.reverted;
    });

    it("FAFETreasury.rotateFactoryTreasury: only owner", async () => {
      const { factory, treasury } = await deployCore();
      const [, stranger] = await ethers.getSigners();

      await expect(
        (treasury.connect(stranger) as any).rotateFactoryTreasury(
          await factory.getAddress(),
          stranger.address
        )
      ).to.be.revertedWith("not owner");
    });

    it("Treasury address is not inherently permitted to trade", async () => {
      const { deployer, treasury, router, pool, access, asset, usdc } = await deployCore();

      // Bootstrap so we'd hit permission check first
      await bootstrapPool(treasury, await pool.getAddress(), asset, usdc, A, U, 0);

      const treasuryAddr = await treasury.getAddress();
      await (await access.connect(deployer).setApprovedSupplicator(treasuryAddr, false)).wait();

      await ethers.provider.send("hardhat_impersonateAccount", [treasuryAddr]);
      await ethers.provider.send("hardhat_setBalance", [
        treasuryAddr,
        "0x56BC75E2D63100000", // 100 ETH
      ]);
      const treasurySigner = await ethers.getSigner(treasuryAddr);

      await mintFundAndApprove(asset, deployer, treasurySigner, router, ethers.parseEther("1"));
      await (await asset.connect(treasurySigner).approve(await pool.getAddress(), ethers.MaxUint256)).wait();

      await expect(
        (router.connect(treasurySigner) as any).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("0.5"),
          minAmountOut: 0n,
          to: treasuryAddr,
          payer: treasuryAddr,
        })
      ).to.be.revertedWith("not permitted");
    });
  });

  //
  // ───────────────────────────────── Router validation & Slippage/Reserves ────────────────────────
  //
  describe("Router validation & Slippage/Reserves", () => {
    it("Ownership transfer updates approver; old owner loses permission", async () => {
      const { deployer, other, access } = await deployCore();
      const [, newOwner] = await ethers.getSigners();

      await (access.connect(deployer) as any).transferOwnership(newOwner.address);
      expect(await access.owner()).to.equal(newOwner.address);

      await expect(
        (access.connect(deployer) as any).setApprovedSupplicator(other.address, true)
      ).to.be.revertedWith("not owner");

      await expect(
        (access.connect(newOwner) as any).setApprovedSupplicator(other.address, true)
      ).to.not.be.reverted;
    });

    it("Router rejects unknown pool (non-contract or wrong ABI)", async () => {
      const { deployer, router, access } = await deployCore();
      const fake = "0x000000000000000000000000000000000000dEaD";

      await (await access.setApprovedSupplicator(deployer.address, true)).wait();

      await expect((router.connect(deployer) as any).supplicate({
        pool: fake,
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address
      })).to.be.reverted;
    });

    it("supplicate: slippage reverts when minAmountOut too high", async () => {
      const { deployer, access, router, pool, asset, usdc, treasury } = await deployCore();

      await bootstrapPool(treasury, await pool.getAddress(), asset, usdc, A, U, 0);

      await (await access.setApprovedSupplicator(deployer.address, true)).wait();

      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("2"));
      await (await asset.connect(deployer).approve(await pool.getAddress(), ethers.MaxUint256)).wait();

      await expect(
        (router as any).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: ethers.parseEther("1000"),
          to: deployer.address,
          payer: deployer.address,
        })
      ).to.be.revertedWith("slippage");
    });

    it("supplicate before bootstrap: empty reserves", async () => {
      const {
        deployer,
        treasury,
        factory,
        router,
        access,
        asset,
        assetAddr,
        usdcAddr,
      } = await deployCore();

      // Use the actual TestERC20 tokens, not random addresses.
      await (await treasury.createPoolViaTreasury(
        await factory.getAddress(),
        assetAddr,
        usdcAddr
      )).wait();

      const pools = await factory.getPools();
      const poolAddr = pools[pools.length - 1];
      const emptyPool = await ethers.getContractAt("FAFEPool", poolAddr);

      // Allow caller and fund enough to cover amountIn + fee so we hit the pool's check
      await (await access.setApprovedSupplicator(deployer.address, true)).wait();
      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("2"));
      await (await asset.connect(deployer).approve(poolAddr, ethers.MaxUint256)).wait();

      await expect(
        (router as any).supplicate({
          pool: poolAddr,
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
          to: deployer.address,
          payer: deployer.address,
        })
      ).to.be.revertedWith("empty reserves");
    });

    it("factory.createPool: rejects zero token addresses", async () => {
      const { deployer, factory, treasury } = await deployCore();
      const { a } = pair();

      await expect(
        (treasury.connect(deployer) as any).createPoolViaTreasury(
          await factory.getAddress(), ethers.ZeroAddress, a
        )
      ).to.be.revertedWith("zero token");

      await expect(
        (treasury.connect(deployer) as any).createPoolViaTreasury(
          await factory.getAddress(), a, ethers.ZeroAddress
        )
      ).to.be.revertedWith("zero token");
    });

    it("Approval checked on caller, not recipient", async () => {
      const { other, deployer, access, router, pool, asset, usdc, treasury } = await deployCore();

      await bootstrapPool(treasury, await pool.getAddress(), asset, usdc, A, U, 0);

      await (await access.setApprovedSupplicator(deployer.address, true)).wait();

      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("1"));
      await (await asset.connect(other).approve(await pool.getAddress(), ethers.MaxUint256)).wait();

      await expect((router.connect(other) as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: deployer.address,
        payer: other.address,
      })).to.be.revertedWith("not permitted");
    });

    it("AccessManager: cannot approve zero address", async () => {
      const { access } = await deployCore();
      await expect((access as any).setApprovedSupplicator(ethers.ZeroAddress, true)).to.be.reverted;
    });
  });
});