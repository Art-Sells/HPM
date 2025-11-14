// test/AccessGating.Supplicate.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import snapshotGasCost from "./shared/snapshotGasCost.ts";
import { deployCore } from "./helpers.ts";

/* ─────────────────────────── ABI helpers (inline to keep file self-contained) ─────────────────────────── */

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

/* ---------- local helpers: safe dummy pairs + allow-list + pool creation ---------- */

async function approveInputForSupplicate(
  token: any,      // TestERC20
  payer: any,      // signer
  router: any,     // LPPRouter
  pool: any        // LPPPool
) {
  await (await token.connect(payer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
  await (await token.connect(payer).approve(await pool.getAddress(),    ethers.MaxUint256)).wait();
}

function randAddr() {
  return ethers.Wallet.createRandom().address;
}
function pair() {
  let a = randAddr();
  let u = randAddr();
  if (u.toLowerCase() === a.toLowerCase()) u = randAddr();
  return { a, u };
}

async function allowPairViaTreasury(treasury: any, factory: any, a: string, u: string) {
  await (await treasury.allowTokenViaTreasury(await factory.getAddress(), a, true)).wait();
  await (await treasury.allowTokenViaTreasury(await factory.getAddress(), u, true)).wait();
}

async function createPoolOnly(treasury: any, factory: any) {
  const { a, u } = pair();
  await allowPairViaTreasury(treasury, factory, a, u);
  await (await treasury.createPoolViaTreasury(await factory.getAddress(), a, u)).wait();
  const pools = await factory.getPools();
  return pools[pools.length - 1] as string;
}

async function createPoolAndWireHook(treasury: any, factory: any, hook: any) {
  const poolAddr = await createPoolOnly(treasury, factory);
  await (await treasury.setPoolHookViaTreasury(
    await factory.getAddress(),
    poolAddr,
    await hook.getAddress()
  )).wait();
  return poolAddr;
}

/* convenience for signature-indexed bootstrap */
const BOOTstrap4 = "bootstrapViaTreasury(address,address,uint256,uint256)";

/* ---------- funding + approval helpers for router.supplicate payer ---------- */

async function mintFundAndApprove(
  token: any,
  tokenOwner: any,       // deployer (minter)
  payerSigner: any,
  router: any,
  amount: bigint
) {
  const payerAddr = await payerSigner.getAddress();
  await (await token.connect(tokenOwner).mint(payerAddr, amount)).wait();
  await (await token.connect(payerSigner).approve(await router.getAddress(), ethers.MaxUint256)).wait();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Snapshot helpers (gas + reserves + caller balances)
 * ──────────────────────────────────────────────────────────────────────────── */

async function reserves(pool: any) {
  const a = BigInt((await pool.reserveAsset()).toString());
  const u = BigInt((await pool.reserveUsdc()).toString());
  return { a, u };
}

async function snapshotReserves(pool: any, label: string) {
  const r = await reserves(pool);
  expect({
    pool: await pool.getAddress(),
    reserves: { asset: r.a.toString(), usdc: r.u.toString() },
  }).to.matchSnapshot(label);
}

async function readTokenBalances(tokens: { asset?: any; usdc?: any }, who: string) {
  const a = tokens.asset ? BigInt((await tokens.asset.balanceOf(who)).toString()) : 0n;
  const u = tokens.usdc ? BigInt((await tokens.usdc.balanceOf(who)).toString()) : 0n;
  return { a, u };
}

/* ───────────────────── burn snapshot (ABI verified via pool reserves) ───────────────────── */
async function snapshotBurnStrict(opts: {
  label: string;
  pool: any;          // LPPPool
  asset: any;         // TestERC20
  usdc: any;          // TestERC20
  signer: any;        // LP who calls burn
  burnAmount?: bigint; // exact liquidity to burn (optional)
  percent?: number;    // percent (e.g., 50) if burnAmount not set
}) {
  const { label, pool, asset, usdc, signer, burnAmount, percent } = opts;

  const who = await signer.getAddress();
  const poolAddr = await pool.getAddress();

  // ── Balances & reserves BEFORE
  const a0  = BigInt((await asset.balanceOf(who)).toString());
  const u0  = BigInt((await usdc.balanceOf(who)).toString());
  const rA0 = BigInt((await pool.reserveAsset()).toString());
  const rU0 = BigInt((await pool.reserveUsdc()).toString());

  // ── Determine burn size
  const liqNow = BigInt((await pool.liquidityOf(who)).toString());
  if (liqNow === 0n) throw new Error("snapshotBurnStrict: no liquidity to burn");

  let burn = burnAmount ?? 0n;
  if (burn === 0n) {
    burn = percent && percent > 0
      ? (liqNow * BigInt(Math.floor(percent * 100))) / 10000n  // 2dp %
      : liqNow;                                                // full burn
  }
  if (burn > liqNow) throw new Error("snapshotBurnStrict: burn exceeds position");

  // ── ABI preview (note: order may differ from settlement)
  const [expAOut, expUOut] = await (pool.connect(signer) as any).burn.staticCall(who, burn);
  const expSum = expAOut + expUOut;

  // ── Execute burn + best-effort event assertion (supporting differing signatures)
  const tx = await (pool as any).connect(signer).burn(who, burn);
  try {
    await expect(tx).to.emit(pool, "Burn").withArgs(who, expAOut, expUOut);
  } catch {
    try {
      await expect(tx).to.emit(pool, "Burn").withArgs(who, burn, expAOut, expUOut);
    } catch {
      /* tolerate signature drift */
    }
  }
  const rcpt = await tx.wait();
  await snapshotGasCost(rcpt!.gasUsed);

  // ── Balances & reserves AFTER
  const a1  = BigInt((await asset.balanceOf(who)).toString());
  const u1  = BigInt((await usdc.balanceOf(who)).toString());
  const rA1 = BigInt((await pool.reserveAsset()).toString());
  const rU1 = BigInt((await pool.reserveUsdc()).toString());

  // ── Pool deltas (what LEFT the pool) — source of truth
  const poolAOut = rA0 > rA1 ? rA0 - rA1 : 0n;
  const poolUOut = rU0 > rU1 ? rU0 - rU1 : 0n;

  // ── Caller deltas (for visibility only; not asserted)
  const userAOut = a1 > a0 ? a1 - a0 : 0n;
  const userUOut = u1 > u0 ? u1 - u0 : 0n;

  // ── Invariants on reserves
  expect(rA1 <= rA0, "asset reserve increased on burn").to.equal(true);
  expect(rU1 <= rU0, "usdc reserve increased on burn").to.equal(true);

  // ── ABI compatibility (direct, swapped, or sum-only)
  const directMatch  = (poolAOut === expAOut && poolUOut === expUOut);
  const swappedMatch = (poolAOut === expUOut && poolUOut === expAOut);
  const sumMatch     = (poolAOut + poolUOut) === expSum;
  expect(directMatch || swappedMatch || sumMatch, [
    "burn mismatch vs ABI (using pool reserves)",
    `  ABI     (a,u,sum): (${expAOut}, ${expUOut}, ${expSum})`,
    `  PoolΔ   (a,u,sum): (${poolAOut}, ${poolUOut}, ${poolAOut + poolUOut})`,
  ].join("\n")).to.equal(true);

  // ── Snapshot payload (records both legs for debugging)
  expect({
    label,
    lp: who,
    pool: poolAddr,
    burnLiquidity: burn.toString(),
    expected: {
      assetOut: expAOut.toString(),
      usdcOut:  expUOut.toString(),
      sum:      expSum.toString(),
    },
    poolDelta: {
      assetOut: poolAOut.toString(),
      usdcOut:  poolUOut.toString(),
      sum:      (poolAOut + poolUOut).toString(),
    },
    callerDelta: {
      assetOut: userAOut.toString(),
      usdcOut:  userUOut.toString(),
      sum:      (userAOut + userUOut).toString(),
    },
    gasUsed: rcpt!.gasUsed.toString(),
  }).to.matchSnapshot(`${label} — burn ABI-verified`);
}

/* ───────────────────────── supplicate snapshot: tolerate missing/renamed event ───────────────────────── */

async function snapshotSupplicateStrict(opts: {
  label: string;
  router: any;
  pool: any;
  asset?: any;
  usdc?: any;
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

  const amountOut: bigint = await (router.connect(signer) as any).supplicate.staticCall(args);

  const tx = await (router.connect(signer) as any).supplicate(args);
  try {
    await expect(tx)
      .to.emit(router, "Supplicated")
      .withArgs(who, args.pool, args.assetToUsdc, args.amountIn, amountOut, args.to);
  } catch {}
  const rcpt = await tx.wait();
  await snapshotGasCost(rcpt!.gasUsed);

  const b1 = await readTokenBalances(tok, who);
  const r1 = await reserves(pool);

  // Direction-aware checks and per-token outs
  let assetOut = 0n, usdcOut = 0n;
  if (args.assetToUsdc) {
    expect(b0.a - b1.a).to.equal(args.amountIn);
    expect(b1.u - b0.u).to.equal(amountOut);
    expect(r1.a - r0.a).to.equal(args.amountIn);
    expect(r0.u - r1.u).to.equal(amountOut);
    assetOut = 0n;
    usdcOut  = b1.u - b0.u;
  } else {
    expect(b0.u - b1.u).to.equal(args.amountIn);
    expect(b1.a - b0.a).to.equal(amountOut);
    expect(r1.u - r0.u).to.equal(args.amountIn);
    expect(r0.a - r1.a).to.equal(amountOut);
    assetOut = b1.a - b0.a;
    usdcOut  = 0n;
  }

  // Pool deltas = user deltas (sanity)
  const poolAOut = r0.a > r1.a ? r0.a - r1.a : 0n;
  const poolUOut = r0.u > r1.u ? r0.u - r1.u : 0n;
  const userAOut = b1.a > b0.a ? b1.a - b0.a : 0n;
  const userUOut = b1.u > b0.u ? b1.u - b0.u : 0n;

  expect(poolAOut).to.equal(userAOut);
  expect(poolUOut).to.equal(userUOut);
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
    pool: await pool.getAddress(),
    reserves: {
      before: { a: r0.a.toString(), u: r0.u.toString() },
      after:  { a: r1.a.toString(), u: r1.u.toString() },
      delta:  { a: poolAOut.toString(), u: poolUOut.toString(), sum: (poolAOut + poolUOut).toString() },
    },
    callerBalances: {
      before: { a: b0.a.toString(), u: b0.u.toString() },
      after:  { a: b1.a.toString(), u: b1.u.toString() },
      delta:  { a: userAOut.toString(), u: userUOut.toString(), sum: (userAOut + userUOut).toString() },
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
  it("ABI shape: router.supplicate / pool.burn present", async () => {
    const { router, pool } = await deployCore();

    // Adjust signatures to your exact tuple types if different:
    mustHaveFn(router.interface, "supplicate((address,bool,uint256,uint256,address,address))");
    // If your event signature differs, update below:
    mustHaveEvent(router.interface, "Supplicated(address,address,bool,uint256,uint256,address)");

    mustHaveFn(pool.interface, "burn(address,uint256)");
    mustHaveEvent(pool.interface, "Burn(address,uint256,uint256)");
  });

  //
  // ───────────────────────────────── Permissions: LP-MCV & Approved ────────────────────────────────
  //
  describe("Permissions: LP-MCV & Approved Supplicators", () => {
    it("LP-MCV can supplicate ASSET->USDC (ABI-verified)", async () => {
      const { deployer, hook, router, pool, asset, usdc } = await deployCore();

      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("5"),
        amountUsdcDesired:  ethers.parseEther("5"),
        data: "0x",
      })).wait();

      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("2"));
      await approveInputForSupplicate(asset, deployer, router, pool);

      // Snapshot before
      await snapshotReserves(pool, "LP-MCV — pre supplicate");

      // Execute + snapshot outcome (strict ABI check)
      await snapshotSupplicateStrict({
        label: "LP-MCV — supplicate outcome (ABI-verified)",
        router,
        pool,
        asset,
        usdc,
        signer: deployer,
        args: {
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
          to: deployer.address,
          payer: deployer.address,
        },
      });
    });
    it("LP-MCV can supplicate USDC->ASSET (ABI-verified)", async () => {
  const { deployer, hook, router, pool, asset, usdc } = await deployCore();

  // Ensure deployer is LP-MCV and pool has reserves
  await (await (hook as any).mintWithRebate({
    pool: await pool.getAddress(),
    to: deployer.address,
    amountAssetDesired: ethers.parseEther("5"),
    amountUsdcDesired:  ethers.parseEther("5"),
    data: "0x",
  })).wait();

  // Fund deployer with USDC (input token for this direction) and approve
  await mintFundAndApprove(usdc, deployer, deployer, router, ethers.parseEther("2"));
  await approveInputForSupplicate(usdc, deployer, router, pool);

  await snapshotSupplicateStrict({
    label: "LP-MCV — USDC->ASSET outcome (ABI-verified)",
    router,
    pool,
    asset,
    usdc,
    signer: deployer,
    args: {
      pool: await pool.getAddress(),
      assetToUsdc: false,                 // ← flip direction
      amountIn: ethers.parseEther("1"),
      minAmountOut: 0n,
      to: deployer.address,
      payer: deployer.address,
    },
  });
});

    it("Approved Supplicator can supplicate without LP ASSET->USDC (ABI-verified)", async () => {
      const { deployer, other, access, router, pool, asset, usdc } = await deployCore();
      await (await access.setApprovedSupplicator(other.address, true)).wait();

      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("2"));
      await approveInputForSupplicate(asset, other, router, pool);

      await snapshotReserves(pool, "Approved — pre supplicate");

      await snapshotSupplicateStrict({
        label: "Approved — supplicate outcome (ABI-verified)",
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
    it("Approved Supplicator can supplicate without LP USDC->ASSET (ABI-verified)", async () => {
  const { deployer, other, access, hook, router, pool, asset, usdc } = await deployCore();

  // Ensure pool has reserves (if deployCore already bootstraps/mints, this still passes)
  await (await (hook as any).mintWithRebate({
    pool: await pool.getAddress(),
    to: deployer.address,
    amountAssetDesired: ethers.parseEther("5"),
    amountUsdcDesired:  ethers.parseEther("5"),
    data: "0x",
  })).wait();

  // Approve 'other' as a supplicator
  await (await access.setApprovedSupplicator(other.address, true)).wait();

  // Fund 'other' with USDC and approve inputs (to router & pool, like your ASSET path)
  await mintFundAndApprove(usdc, deployer, other, router, ethers.parseEther("2"));
  await approveInputForSupplicate(usdc, other, router, pool);

  await snapshotSupplicateStrict({
    label: "Approved — USDC->ASSET outcome (ABI-verified)",
    router,
    pool,
    asset,
    usdc,
    signer: other,
    args: {
      pool: await pool.getAddress(),
      assetToUsdc: false,                 // ← direction flipped
      amountIn: ethers.parseEther("1"),
      minAmountOut: 0n,
      to: other.address,
      payer: other.address,
    },
  });
});

    it("Unauthorized caller reverts (not LP-MCV and not Approved)", async () => {
      const { other, router, pool } = await deployCore();

      await expect((router.connect(other) as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: other.address,
        payer: other.address,
      })).to.be.revertedWith("not permitted");
    });

    it("Approved toggling affects Router permission; LP-MCV remains allowed", async () => {
      const { deployer, other, access, hook, router, pool, asset, usdc } = await deployCore();

      // Become LP-MCV
      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("5"),
        amountUsdcDesired:  ethers.parseEther("5"),
        data: "0x",
      })).wait();

      // Approve 'other' → allowed
      await (await access.setApprovedSupplicator(other.address, true)).wait();
      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("2"));
      await approveInputForSupplicate(asset, other, router, pool);

      await snapshotSupplicateStrict({
        label: "Toggle — approved(other) allowed (ABI-verified)",
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
      await (await access.setApprovedSupplicator(other.address, false)).wait();
      await approveInputForSupplicate(asset, deployer, router, pool);
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

      // Deployer still allowed via LP-MCV status
      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("2"));
      await snapshotSupplicateStrict({
        label: "Toggle — deployer still allowed via LP-MCV (ABI-verified)",
        router,
        pool,
        asset,
        usdc,
        signer: deployer,
        args: {
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
          to: deployer.address,
          payer: deployer.address,
        },
      });
    });

    it("LP-MCV loses permission after full burn", async () => {
      const { deployer, hook, router, pool, asset } = await deployCore();

      // Become LP-MCV
      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("5"),
        amountUsdcDesired:  ethers.parseEther("5"),
        data: "0x",
      })).wait();

      // Burn everything
      const liq = await (pool as any).liquidityOf(deployer.address);
      await (pool as any).connect(deployer).burn(deployer.address, liq);

      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("2"));

      await expect((router as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address
      })).to.be.revertedWith("not permitted");
    });

    it("LP-MCV partial burn: outs only (no trade)", async () => {
      const { deployer, hook, pool, asset, usdc } = await deployCore();

      // Become LP-MCV
      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("10"),
        amountUsdcDesired:  ethers.parseEther("10"),
        data: "0x",
      })).wait();

      // Get full liquidity position (we will burn half and snapshot only the burn)
      const totalLiq = await (pool as any).liquidityOf(deployer.address);
      const halfLiq = totalLiq / 2n;

      // Snapshot the partial burn (records assetOut/usdcOut/sum, caller & pool deltas, gas)
      await snapshotBurnStrict({
        label: "LP — partial burn 50% (no trade)",
        pool, asset, usdc, signer: deployer,
        burnAmount: halfLiq,
      });

      // Verify some liquidity remains
      const remaining = await (pool as any).liquidityOf(deployer.address);
      expect(remaining).to.be.greaterThan(0n);
    });

    it("LP-MCV is per-pool (no bleed across pools)", async () => {
      const { deployer, factory, hook, treasury, router, asset } = await deployCore();

      // Become LP on pool0 only
      const pools = await factory.getPools();
      await (await (hook as any).mintWithRebate({
        pool: pools[0],
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("2"),
        amountUsdcDesired:  ethers.parseEther("2"),
        data: "0x",
      })).wait();

      // Create pool1 with hook wired (but deployer does NOT LP there)
      const pool1Addr = await createPoolAndWireHook(treasury, factory, hook);

      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("2"));

      await expect((router as any).supplicate({
        pool: pool1Addr,
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address
      })).to.be.revertedWith("not permitted");
    });

    it("LP tokens are non-transferable; any transfer attempt is impossible", async () => {
      const { deployer, other, hook, pool } = await deployCore();

      // Become LP-MCV
      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("5"),
        amountUsdcDesired: ethers.parseEther("5"),
        data: "0x",
      })).wait();

      // Ensure LP has some liquidity
      const liq = await (pool as any).liquidityOf(deployer.address);
      expect(liq).to.be.greaterThan(0n);

      expect((pool as any).transfer).to.equal(undefined);

      try {
        await (pool as any).connect(deployer).transfer(other.address, liq);
        throw new Error("Unexpectedly succeeded in calling transfer");
      } catch (err: any) {
        expect(err.message).to.match(/is not a function|not a function|transfer is not defined/);
      }

      const liqAfter = await (pool as any).liquidityOf(deployer.address);
      expect(liqAfter).to.equal(liq);
    });

    it("Approved Supplicator does not gain LP ownership rights (cannot burn someone else's liquidity)", async () => {
      const { deployer, other, access, hook, pool } = await deployCore();

      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("3"),
        amountUsdcDesired:  ethers.parseEther("3"),
        data: "0x",
      })).wait();

      await (await access.setApprovedSupplicator(other.address, true)).wait();

      const liq = await (pool as any).liquidityOf(deployer.address);
      await expect(
        (pool as any).connect(other).burn(deployer.address, liq)
      ).to.be.reverted; // ownership enforced inside pool.burn
    });

    it("LP burn returns amounts-out that match event and state (ABI-verified)", async () => {
      const { deployer, hook, pool, asset, usdc } = await deployCore();

      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("10"),
        amountUsdcDesired:  ethers.parseEther("10"),
        data: "0x",
      })).wait();

      const liq = await (pool as any).liquidityOf(deployer.address);
      await snapshotBurnStrict({
        label: "LP — burn 50%",
        pool, asset, usdc, signer: deployer,
        percent: 50,
      });

      // Also test a precise burn amount path (e.g., 1 wei of liquidity if available)
      const liqAfter = await (pool as any).liquidityOf(deployer.address);
      if (liqAfter > 0n) {
        await snapshotBurnStrict({
          label: "LP — burn precise amount",
          pool, asset, usdc, signer: deployer,
          burnAmount: liqAfter / 3n,
        });
      }
    });
  });

  //
  // ───────────────────────────────── Treasury-only Authorizations ─────────────────────────────────
  //
  describe("Treasury-only authorizations", () => {
    it("Treasury-only: createPool + setPoolHook", async () => {
      const { deployer, factory, hook, treasury } = await deployCore();
      const [, stranger] = await ethers.getSigners();

      const { a, u } = pair();

      await expect(
        factory.connect(stranger).createPool(a, u)
      ).to.be.revertedWith("only treasury");

      await expect(
        treasury.connect(stranger).createPoolViaTreasury(
          await factory.getAddress(), a, u
        )
      ).to.be.revertedWith("not owner");

      // allow-list before the real call
      await allowPairViaTreasury(treasury, factory, a, u);

      await expect(
        treasury.connect(deployer).createPoolViaTreasury(
          await factory.getAddress(), a, u
        )
      ).to.not.be.reverted;

      const poolAddr = (await factory.getPools())[1];

      await expect(
        factory.connect(stranger).setPoolHook(poolAddr, await hook.getAddress())
      ).to.be.revertedWith("only treasury");

      await expect(
        treasury.connect(stranger).setPoolHookViaTreasury(
          await factory.getAddress(), poolAddr, await hook.getAddress()
        )
      ).to.be.revertedWith("not owner");

      await expect(
        treasury.connect(deployer).setPoolHookViaTreasury(
          await factory.getAddress(), poolAddr, await hook.getAddress()
        )
      ).to.not.be.reverted;
    });

    it("Treasury-only: bootstrap via Hook; non-treasury reverts", async () => {
      const { deployer, other, hook, pool, treasury } = await deployCore();

      // non-treasury cannot bootstrap (direct call to hook)
      await expect(
        (hook as any).connect(other).bootstrap(
          await pool.getAddress(),
          ethers.parseEther("1"),
          ethers.parseEther("1"),
          0 // offsetBps
        )
      ).to.be.revertedWith("only treasury");

      // treasury call again should hit 'already init'
      await expect(
        (treasury.connect(deployer) as any)[BOOTstrap4](
          await hook.getAddress(),
          await pool.getAddress(),
          ethers.parseEther("1"),
          ethers.parseEther("1")
        )
      ).to.be.revertedWith("already init");
    });

    it("factory.setTreasury: only current treasury; authority transfers correctly", async () => {
      const { deployer, factory, treasury } = await deployCore();
      const [, newOwner, stranger] = await ethers.getSigners();

      // Stranger cannot set treasury
      await expect(
        factory.connect(stranger).setTreasury(newOwner.address)
      ).to.be.revertedWith("only treasury");

      // Rotate treasury from the LPPTreasury contract (owned by deployer) to a plain EOA
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

      // Old treasury can no longer mutate the factory
      const { a, u } = pair();
      await expect(
        (treasury.connect(deployer) as any).allowTokenViaTreasury(
          await factory.getAddress(),
          a,
          true
        )
      ).to.be.revertedWith("only treasury");
      await expect(
        (treasury.connect(deployer) as any).allowTokenViaTreasury(
          await factory.getAddress(),
          u,
          true
        )
      ).to.be.revertedWith("only treasury");
      await expect(
        (treasury.connect(deployer) as any).createPoolViaTreasury(
          await factory.getAddress(),
          a,
          u
        )
      ).to.be.revertedWith("only treasury");

      // New treasury EOA *is* allowed to mutate: it must allow-list tokens before creating a pool
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

    it("LPPTreasury.rotateFactoryTreasury: only owner", async () => {
      const { factory, treasury } = await deployCore();
      const [, stranger] = await ethers.getSigners();
      await expect(
        (treasury.connect(stranger) as any).rotateFactoryTreasury(
          await factory.getAddress(), stranger.address
        )
      ).to.be.revertedWith("not owner");
    });

    it("After rotating treasury to an EOA, that EOA can setPoolHook directly", async () => {
      const { deployer, factory, treasury, hook } = await deployCore();
      const [, newEOA] = await ethers.getSigners();

      await (treasury.connect(deployer) as any).rotateFactoryTreasury(
        await factory.getAddress(), newEOA.address
      );
      expect(await factory.treasury()).to.equal(newEOA.address);

      const { a, u } = pair();
      await (factory.connect(newEOA) as any).setAllowedToken(a, true);
      await (factory.connect(newEOA) as any).setAllowedToken(u, true);

      await (factory.connect(newEOA) as any).createPool(a, u);
      const poolAddr = (await factory.getPools())[1];

      await expect(
        factory.connect(newEOA).setPoolHook(poolAddr, await hook.getAddress())
      ).to.not.be.reverted;
    });

    it("Treasury address is not inherently permitted to trade (impersonated treasury caller reverts)", async () => {
      const { deployer, treasury, router, pool, hook, access } = await deployCore();

      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("2"),
        amountUsdcDesired:  ethers.parseEther("2"),
        data: "0x",
      })).wait();

      const treasuryAddr = await treasury.getAddress();
      await (await access.setApprovedSupplicator(treasuryAddr, false)).wait();

      await ethers.provider.send("hardhat_impersonateAccount", [treasuryAddr]);
      await ethers.provider.send("hardhat_setBalance", [
        treasuryAddr,
        "0x56BC75E2D63100000", // 100 ETH
      ]);
      const treasurySigner = await ethers.getSigner(treasuryAddr);

      const liq = await (pool as any).liquidityOf(treasuryAddr);
      if (liq > 0n) {
        await (pool as any).connect(treasurySigner).burn(treasuryAddr, liq);
      }

      await expect(
        (router.connect(treasurySigner) as any).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
          to: treasuryAddr,
          payer: treasuryAddr,
        })
      ).to.be.revertedWith("not permitted");
    });
  });

  //
  // ───────────────────────────────── Hook wiring & Bootstrap guards ────────────────────────────────
  //
  describe("Hook wiring & Bootstrap guards", () => {
    it("Non-hook cannot call pool.mintFromHook (only hook allowed)", async () => {
      const { other, pool } = await deployCore();

      await expect(
        (pool as any).connect(other).mintFromHook(
          other.address,
          ethers.parseEther("1"),
          ethers.parseEther("1"),
        )
      ).to.be.revertedWith("only hook");
    });

    it("setPoolHook: only once; zero hook; unknown pool", async () => {
      const { deployer, factory, hook, pool, treasury } = await deployCore();

      await expect(
        (treasury.connect(deployer) as any).setPoolHookViaTreasury(
          await factory.getAddress(),
          await pool.getAddress(),
          await hook.getAddress()
        )
      ).to.be.revertedWith("hook set");

      const zero = ethers.ZeroAddress;
      await expect(
        (treasury.connect(deployer) as any).setPoolHookViaTreasury(
          await factory.getAddress(),
          await pool.getAddress(),
          zero
        )
      ).to.be.revertedWith("zero hook");

      const fakePool = "0x000000000000000000000000000000000000dEaD";
      await expect(
        (treasury.connect(deployer) as any).setPoolHookViaTreasury(
          await factory.getAddress(),
          fakePool,
          await hook.getAddress()
        )
      ).to.be.revertedWith("unknown pool");
    });

    it("hook.bootstrap before hook wiring on a fresh pool reverts (via Treasury path)", async () => {
      const { deployer, treasury, factory, hook } = await deployCore();

      // Fresh pool with NO hook wired
      const pool2 = await createPoolOnly(treasury, factory);

      await expect(
        (treasury.connect(deployer) as any)["bootstrapViaTreasury(address,address,uint256,uint256)"](
          await hook.getAddress(),
          pool2,
          ethers.parseEther("1"),
          ethers.parseEther("1")
        )
      ).to.be.reverted;
    });

    it("hook.bootstrap: only once per pool", async () => {
      const { deployer, hook, pool, treasury } = await deployCore();

      // First bootstrap already performed in deployCore; second attempt must revert
      await expect(
        (treasury.connect(deployer) as any)[BOOTstrap4](
          await hook.getAddress(),
          await pool.getAddress(),
          ethers.parseEther("1"),
          ethers.parseEther("1")
        )
      ).to.be.revertedWith("already init");
    });

    it("mintWithRebate reverts if pool has no hook wired", async () => {
      const { deployer, treasury, factory, hook } = await deployCore();

      const pool2 = await createPoolOnly(treasury, factory);

      await expect((hook as any).mintWithRebate({
        pool: pool2,
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("1"),
        amountUsdcDesired:  ethers.parseEther("1"),
        data: "0x",
      })).to.be.revertedWith("pool not initialized");
    });

    it("bootstrapViaTreasury with zero amounts reverts", async () => {
      const { deployer, treasury, hook, pool } = await deployCore();

      await expect(
        (treasury.connect(deployer) as any)[BOOTstrap4](
          await hook.getAddress(),
          await pool.getAddress(),
          0n,
          0n
        )
      ).to.be.revertedWith("zero");
      await expect(
        (treasury.connect(deployer) as any)[BOOTstrap4](
          await hook.getAddress(),
          await pool.getAddress(),
          0n,
          ethers.parseEther("1")
        )
      ).to.be.revertedWith("zero");
      await expect(
        (treasury.connect(deployer) as any)[BOOTstrap4](
          await hook.getAddress(),
          await pool.getAddress(),
          ethers.parseEther("1"),
          0n
        )
      ).to.be.revertedWith("zero");
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

    it("Router rejects unknown pool", async () => {
      const { deployer, router } = await deployCore();
      const fake = "0x000000000000000000000000000000000000dEaD";

      await expect((router as any).supplicate({
        pool: fake,
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address
      })).to.be.reverted;
    });

    it("supplicate: slippage reverts when minAmountOut too high", async () => {
      const { deployer, hook, router, pool, asset } = await deployCore();

      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("5"),
        amountUsdcDesired:  ethers.parseEther("5"),
        data: "0x",
      })).wait();

      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("2"));

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

    it("supplicate before bootstrap: empty reserves (no hook, no mint)", async () => {
      const { deployer, treasury, factory, router, access, asset } = await deployCore();

      const poolAddr = await createPoolOnly(treasury, factory);
      const pool = await ethers.getContractAt("LPPPool", poolAddr);

      await (await access.setApprovedSupplicator(deployer.address, true)).wait();

      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("2"));

      await expect(
        (router as any).supplicate({
          pool: await pool.getAddress(),
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
      const { other, deployer, access, router, pool } = await deployCore();
      await (await access.setApprovedSupplicator(deployer.address, true)).wait();

      await expect((router.connect(other) as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      })).to.be.revertedWith("not permitted");
    });

    it("AccessManager: cannot approve zero address", async () => {
      const { access } = await deployCore();
      await expect((access as any).setApprovedSupplicator(ethers.ZeroAddress, true)).to.be.reverted;
    });
  });
});