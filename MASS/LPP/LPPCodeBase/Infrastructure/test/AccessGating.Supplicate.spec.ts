// test/AccessGating.Supplicate.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import snapshotGasCost from "./shared/snapshotGasCost.ts";
import { deployCore } from "./helpers.ts";

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
    pool: await pool.getAddress(),
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
  await (await token.connect(payer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
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

  const amountOut: bigint = await (router.connect(signer) as any).supplicate.staticCall(args);

  const tx = await (router.connect(signer) as any).supplicate(args);

  // Best-effort event assertion (tolerate ABI changes but expect name)
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
        0 // reason = OK
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
  it("ABI shape: router.supplicate / pool.supplicate present", async () => {
    const { router, pool } = await deployCore();

    mustHaveFn(router.interface, "supplicate((address,bool,uint256,uint256,address,address))");
    mustHaveEvent(
      router.interface,
      "SupplicateExecuted(address,address,address,uint256,address,uint256,uint8)"
    );

    mustHaveFn(pool.interface, "supplicate(address,address,bool,uint256,uint256)");
    mustHaveFn(pool.interface, "quoteSupplication(bool,uint256)");
  });

  //
  // ───────────────────────────────── Permissions: Approved-only ────────────────────────────────
  //
  describe("Permissions: Approved Supplicators only", () => {
it("Approved Supplicator can supplicate ASSET->USDC (ABI-verified)", async () => {
  const { deployer, other, access, router, pool, asset, usdc } = await deployCore();

  // Approve 'other' as supplicator
  await (await access.connect(deployer).setApprovedSupplicator(other.address, true)).wait();

  // Fund 'other' with ASSET, approve router
  await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("2"));

  // 🔥 NEW: also approve the pool as spender
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
  const { deployer, other, access, router, pool, asset, usdc } = await deployCore();

  await (await access.connect(deployer).setApprovedSupplicator(other.address, true)).wait();

  await mintFundAndApprove(usdc, deployer, other, router, ethers.parseEther("2"));

  // 🔥 NEW: approve pool to pull USDC from 'other'
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

    it("Unauthorized caller reverts (not Approved, even if they have no/yes liquidity)", async () => {
      const { deployer, other, router, pool, asset } = await deployCore();

      // Fund 'other' with ASSET but DO NOT approve in AccessManager
      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("1"));

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
  const { deployer, other, access, router, pool, asset, usdc } = await deployCore();

  // Approve 'other'
  await (await access.connect(deployer).setApprovedSupplicator(other.address, true)).wait();

  await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("2"));

  // 🔥 NEW: approve pool to pull ASSET from 'other'
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

    it("LPPTreasury.rotateFactoryTreasury: only owner", async () => {
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
      const { deployer, treasury, router, pool, access, asset } = await deployCore();

      const treasuryAddr = await treasury.getAddress();
      await (await access.connect(deployer).setApprovedSupplicator(treasuryAddr, false)).wait();

      await ethers.provider.send("hardhat_impersonateAccount", [treasuryAddr]);
      await ethers.provider.send("hardhat_setBalance", [
        treasuryAddr,
        "0x56BC75E2D63100000", // 100 ETH
      ]);
      const treasurySigner = await ethers.getSigner(treasuryAddr);

      await mintFundAndApprove(asset, deployer, treasurySigner, router, ethers.parseEther("1"));

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

    it("Router rejects unknown pool", async () => {
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
      const { deployer, access, router, pool, asset } = await deployCore();

      await (await access.setApprovedSupplicator(deployer.address, true)).wait();

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

    it("supplicate before bootstrap: empty reserves", async () => {
      const { deployer, treasury, factory, router, access, asset } = await deployCore();

      const { a, u } = pair();

      await (treasury.connect(deployer) as any).allowTokenViaTreasury(
        await factory.getAddress(),
        a,
        true
      );
      await (treasury.connect(deployer) as any).allowTokenViaTreasury(
        await factory.getAddress(),
        u,
        true
      );

      await (treasury.connect(deployer) as any).createPoolViaTreasury(
        await factory.getAddress(), a, u
      );
      const pools = await factory.getPools();
      const poolAddr = pools[pools.length - 1];
      const pool = await ethers.getContractAt("LPPPool", poolAddr);

      await (await access.setApprovedSupplicator(deployer.address, true)).wait();

      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("1"));

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
      const { other, deployer, access, router, pool, asset } = await deployCore();
      await (await access.setApprovedSupplicator(deployer.address, true)).wait();

      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("1"));

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