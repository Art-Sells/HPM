// test/QuoterMCVAccuracy.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import { deployCore } from "./helpers.ts";

import type {
  IERC20,
  TestERC20,
  LPPPool,
  LPPRouter,
  LPPFactory,
  LPPTreasury,
  LPPAccessManager,
  LPPQuoterMCV,
} from "../typechain-types";

/* ────────────────────────────────────────────────────────────────────────────
 * Direction Policy (derived from active set):
 *   NEG set  => ASSET-in (ASSET -> USDC)
 *   POS set  => USDC-in  (USDC  -> ASSET)
 * No independent direction cursor is used.
 * ──────────────────────────────────────────────────────────────────────────── */

const IERC20_FQN = "contracts/external/IERC20.sol:IERC20";
const A = ethers.parseEther("100");
const U = ethers.parseEther("100");

/* ────────────────────────────────────────────────────────────────────────────
 * Small helpers (TypeChain-typed, no manual ABI)
 * ──────────────────────────────────────────────────────────────────────────── */

async function getTokensFromPool(pool: LPPPool): Promise<{ asset: IERC20; usdc: IERC20 }> {
  const assetAddr = await pool.asset();
  const usdcAddr  = await pool.usdc();
  const asset = (await ethers.getContractAt(IERC20_FQN, assetAddr)) as unknown as IERC20;
  const usdc  = (await ethers.getContractAt(IERC20_FQN, usdcAddr))  as unknown as IERC20;
  return { asset, usdc };
}

async function reserves(p: LPPPool) {
  const a = BigInt((await p.reserveAsset()).toString());
  const u = BigInt((await p.reserveUsdc()).toString());
  return { a, u };
}

async function bal(t: IERC20, who: string) {
  return BigInt((await t.balanceOf(who)).toString());
}

async function ensureSixPools(factory: LPPFactory, treasury: LPPTreasury, asset: TestERC20, usdc: TestERC20) {
  const have = (await factory.getPools()).length;
  const need = Math.max(0, 6 - have);
  for (let i = 0; i < need; i++) {
    await (
      await treasury.createPoolViaTreasury(
        await factory.getAddress(),
        await asset.getAddress(),
        await usdc.getAddress()
      )
    ).wait();
  }
  const all = await factory.getPools();
  return all.slice(0, 6);
}

async function bootstrapSix(
  pools: string[],
  treasury: LPPTreasury
) {
  // first 3 NEG (-500), last 3 POS (+500)
  for (let i = 0; i < 3; i++) {
    await (
      await (treasury as any)["bootstrapViaTreasury(address,uint256,uint256,int256)"](
        pools[i], A, U, -500
      )
    ).wait();
  }
  for (let i = 3; i < 6; i++) {
    await (
      await (treasury as any)["bootstrapViaTreasury(address,uint256,uint256,int256)"](
        pools[i], A, U, +500
      )
    ).wait();
  }
}

async function approveForMCV(params: {
  token: IERC20;
  payer: any;
  router: LPPRouter;
  orbit: string[];
  amountIn: bigint;
}) {
  const { token, payer, router, orbit, amountIn } = params;
  await (await token.connect(payer).approve(await router.getAddress(), ethers.MaxUint256)).wait();
  for (const addr of orbit) {
    await (await token.connect(payer).approve(addr, amountIn)).wait();
  }
}

function toBig(x: any) { return BigInt(String(x)); }

/* ────────────────────────────────────────────────────────────────────────────
 * Spec
 * ──────────────────────────────────────────────────────────────────────────── */

describe("MCVQuoterAccuracy", () => {
  it("NEG set first (ASSET-in derived) — quoter == router.static == exec; snapshots", async () => {
    const env = await deployCore();
    const { deployer, router, factory, treasury, asset, usdc, access } = env as {
      deployer: any;
      router: LPPRouter;
      factory: LPPFactory;
      treasury: LPPTreasury;
      asset: TestERC20;
      usdc: TestERC20;
      access: LPPAccessManager;
    };

    // allow deployer to mcvSupplicate
    await (await access.setApprovedSupplicator(deployer.address, true)).wait();

    // 6 pools; bootstrap [-500,-500,-500,+500,+500,+500]
    const six = await ensureSixPools(factory, treasury, asset, usdc);
    await bootstrapSix(six, treasury);

    // start with NEG
    const startPool = six[0];
    await (
      await (treasury as any).setDualOrbitViaTreasury(
        await router.getAddress(),
        startPool,
        [six[0], six[1], six[2]], // NEG
        [six[3], six[4], six[5]], // POS
        /*startWithNeg*/ true
      )
    ).wait();

    const amountIn = ethers.parseEther("1");

    // read active orbit
    const active0 = await (router as any).getActiveOrbit(startPool);
    const orbit0  = active0[0] as string[];
    const usingNeg0 = Boolean(active0[1]);
    expect(usingNeg0).to.equal(true); // NEG active ⇒ ASSET-in

    // pool contracts + tokens typed
    const pool0 = await ethers.getContractAt("LPPPool", orbit0[0]) as unknown as LPPPool;
    const tokens = await getTokensFromPool(pool0);

    // router constants (fee math)
    const BPS = BigInt(await (router as any).BPS_DENOMINATOR());
    const MCV_FEE = BigInt(await (router as any).MCV_FEE_BPS());
    const TRE_CUT = BigInt(await (router as any).TREASURY_CUT_BPS());

    const perHopFee = (amountIn * MCV_FEE) / BPS;   // total fee each hop
    const feeAll    = perHopFee * 3n;               // three hops

    // Direction derived: ASSET-in (NEG). Fund payer with ASSET principal + fees.
    await (await env.asset.connect(deployer).mint(deployer.address, amountIn * 3n + feeAll)).wait();

    // approvals for ASSET
    await approveForMCV({ token: tokens.asset, payer: deployer, router, orbit: orbit0, amountIn });

    // BEFORE snapshots
    const poolsBefore = await Promise.all(
      orbit0.map(async (addr) => {
        const p = await ethers.getContractAt("LPPPool", addr) as unknown as LPPPool;
        const r = await reserves(p);
        return { pool: addr, a: r.a.toString(), u: r.u.toString() };
      })
    );
    const b0A = await bal(tokens.asset, deployer.address);
    const b0U = await bal(tokens.usdc,  deployer.address);

    // Quoter deploy & quote
    const QF = await ethers.getContractFactory("LPPQuoterMCV");
    const quoter = (await QF.deploy()) as unknown as LPPQuoterMCV;
    await quoter.waitForDeployment();

    const qr = await (quoter as any).quoteMCV(
      await router.getAddress(),
      startPool,
      amountIn,
      /*assetToUsdcLegacy*/ true // ignored since dual-orbit is configured
    );

    // Router static (returns sum of hop outs)
    const staticOut: bigint = await (router.connect(deployer) as any).mcvSupplication.staticCall({
      startPool,
      assetToUsdc: true,  // ignored (dual); derived as ASSET-in from NEG
      amountIn,
      payer: deployer.address,
      to: deployer.address,
    });

    // Execute
    const tx = await (router.connect(deployer) as any).mcvSupplication({
      startPool,
      assetToUsdc: true,  // ignored (dual)
      amountIn,
      payer: deployer.address,
      to: deployer.address,
    });
    const rcpt = await tx.wait();

    // AFTER snapshots
    const poolsAfter = await Promise.all(
      orbit0.map(async (addr) => {
        const p = await ethers.getContractAt("LPPPool", addr) as unknown as LPPPool;
        const r = await reserves(p);
        return { pool: addr, a: r.a.toString(), u: r.u.toString() };
      })
    );
    const a1 = await bal(tokens.asset, deployer.address);
    const u1 = await bal(tokens.usdc,  deployer.address);

    // user out is USDC (ASSET-in)
    const userUsdcOut    = u1 > b0U ? u1 - b0U : 0n;
    const userAssetDec   = b0A - a1; // should be 3*amountIn + 3*perHopFee

    // Parse 3 HopExecuted events to prove 3 independent hops
    const HopExecutedSig = ethers.id("HopExecuted(address,bool,address,address,uint256,uint256)");
    const hopTrace = (rcpt?.logs ?? [])
      .filter((l: any) => l.topics && l.topics[0] === HopExecutedSig)
      .map((l: any) => {
        const pool = ethers.getAddress("0x" + l.topics[1].slice(26));
        const [assetToUsdc, tokenIn, tokenOut, amtIn, amtOut] =
          ethers.AbiCoder.defaultAbiCoder().decode(
            ["bool","address","address","uint256","uint256"],
            l.data
          );
        return {
          pool,
          assetToUsdc: Boolean(assetToUsdc),
          amountIn: toBig(amtIn).toString(),
          amountOut: toBig(amtOut).toString(),
          tokenIn,
          tokenOut,
        };
      });

    // Assertions: quoter == static == exec (sum of hop outs)
    const quoterTotal = toBig(qr.totalAmountOut);
    expect(userUsdcOut, "exec vs quoter").to.equal(quoterTotal);
    expect(staticOut,   "static vs quoter").to.equal(quoterTotal);

    // Snapshot object
    expect({
      role: "MCVQuoter",
      usingNeg: Boolean(qr.usingNeg),                 // true
      assetToUsdc: Boolean(qr.assetToUsdc),           // true (ASSET->USDC)
      amountIn: amountIn.toString(),
      fees: {
        perHopTotal: perHopFee.toString(),
        perHopTreasury: ((amountIn * TRE_CUT) / BPS).toString(),
        perHopPools: (perHopFee - (amountIn * TRE_CUT) / BPS).toString(),
      },
      orbit: (qr.orbit as string[]),
      quoter: {
        perHop: (qr.amountOutPerHop as bigint[]).map((x: any) => x.toString()),
        total: quoterTotal.toString(),
      },
      routerStatic: staticOut.toString(),
      execution: {
        userUsdcOut: userUsdcOut.toString(),
        userAssetDecrease: userAssetDec.toString(),
        hops: hopTrace,
      },
      pools: {
        before: poolsBefore,
        after:  poolsAfter,
      },
      note: "NEG set, ASSET-in (direction derived from set). Donation applied to input reserve per hop before quote.",
    }).to.matchSnapshot("MCVQuoter — NEG first (ASSET-in) — quote==static==exec");
  });

  it("POS set first (USDC-in derived) — quoter == router.static == exec; snapshots", async () => {
    const env = await deployCore();
    const { deployer, router, factory, treasury, asset, usdc, access } = env as {
      deployer: any;
      router: LPPRouter;
      factory: LPPFactory;
      treasury: LPPTreasury;
      asset: TestERC20;
      usdc: TestERC20;
      access: LPPAccessManager;
    };

    await (await access.setApprovedSupplicator(deployer.address, true)).wait();

    // 6 pools; bootstrap [-500,-500,-500,+500,+500,+500]
    const six = await ensureSixPools(factory, treasury, asset, usdc);
    await bootstrapSix(six, treasury);

    // POS first (startWithNeg = false)
    const startPool = six[0];
    await (
      await (treasury as any).setDualOrbitViaTreasury(
        await router.getAddress(),
        startPool,
        [six[0], six[1], six[2]], // NEG
        [six[3], six[4], six[5]], // POS
        /*startWithNeg*/ false
      )
    ).wait();

    const amountIn = ethers.parseEther("1");

    // Active orbit should be POS ⇒ USDC-in
    const active0 = await (router as any).getActiveOrbit(startPool);
    const orbit0  = active0[0] as string[];
    const usingNeg0 = Boolean(active0[1]);
    expect(usingNeg0).to.equal(false); // POS set active

    // Tokens from first POS pool
    const pool0 = await ethers.getContractAt("LPPPool", orbit0[0]) as unknown as LPPPool;
    const tokens = await getTokensFromPool(pool0);

    // Fee math from router constants
    const BPS = BigInt(await (router as any).BPS_DENOMINATOR());
    const MCV_FEE = BigInt(await (router as any).MCV_FEE_BPS());
    const TRE_CUT = BigInt(await (router as any).TREASURY_CUT_BPS());
    const perHopFee = (amountIn * MCV_FEE) / BPS;
    const totalFee  = perHopFee * 3n;

    // Fund payer with USDC (USDC-in) for 3 hops + 3 fees and approve router + each POS pool
    await (await env.usdc.connect(deployer).mint(deployer.address, amountIn * 3n + totalFee)).wait();
    await approveForMCV({ token: tokens.usdc, payer: deployer, router, orbit: orbit0, amountIn });

    // BEFORE snapshot
    const poolsBefore = await Promise.all(
      orbit0.map(async (addr) => {
        const p = await ethers.getContractAt("LPPPool", addr) as unknown as LPPPool;
        const a = BigInt((await p.reserveAsset()).toString());
        const u = BigInt((await p.reserveUsdc()).toString());
        return { pool: addr, a: a.toString(), u: u.toString() };
      })
    );
    const b0A = BigInt((await tokens.asset.balanceOf(deployer.address)).toString());
    const b0U = BigInt((await tokens.usdc.balanceOf(deployer.address)).toString());

    // Quoter deploy & quote (should show usingNeg=false, assetToUsdc=false)
    const QF = await ethers.getContractFactory("LPPQuoterMCV");
    const quoter = (await QF.deploy()) as unknown as LPPQuoterMCV;
    await quoter.waitForDeployment();

    const qr = await (quoter as any).quoteMCV(
      await router.getAddress(),
      startPool,
      amountIn,
      /*assetToUsdcLegacy*/ false // ignored in dual-orbit
    );

    // Static call
    const staticOut: bigint = await (router.connect(deployer) as any).mcvSupplication.staticCall({
      startPool,
      assetToUsdc: false,  // ignored (dual)
      amountIn,
      payer: deployer.address,
      to: deployer.address,
    });

    // Execute
    const tx = await (router.connect(deployer) as any).mcvSupplication({
      startPool,
      assetToUsdc: false,  // ignored (dual)
      amountIn,
      payer: deployer.address,
      to: deployer.address,
    });
    const rcpt = await tx.wait();

    // AFTER snapshot + user deltas (USDC-in ⇒ user receives ASSET)
    const poolsAfter = await Promise.all(
      orbit0.map(async (addr) => {
        const p = await ethers.getContractAt("LPPPool", addr) as unknown as LPPPool;
        const a = BigInt((await p.reserveAsset()).toString());
        const u = BigInt((await p.reserveUsdc()).toString());
        return { pool: addr, a: a.toString(), u: u.toString() };
      })
    );
    const a1 = BigInt((await tokens.asset.balanceOf(deployer.address)).toString());
    const u1 = BigInt((await tokens.usdc.balanceOf(deployer.address)).toString());
    const userAssetOut = a1 > b0A ? a1 - b0A : 0n;

    // HopExecuted proof (3 hops)
    const HopExecutedSig = ethers.id("HopExecuted(address,bool,address,address,uint256,uint256)");
    const hopTrace = (rcpt?.logs ?? [])
      .filter((l: any) => l.topics?.[0] === HopExecutedSig)
      .map((l: any) => {
        const pool = ethers.getAddress("0x" + l.topics[1].slice(26));
        const [assetToUsdc, tokenIn, tokenOut, amtIn, amtOut] =
          ethers.AbiCoder.defaultAbiCoder().decode(
            ["bool","address","address","uint256","uint256"],
            l.data
          );
        return {
          pool,
          assetToUsdc: Boolean(assetToUsdc),
          amountIn: BigInt(String(amtIn)).toString(),
          amountOut: BigInt(String(amtOut)).toString(),
          tokenIn,
          tokenOut,
        };
      });

    // Equality checks
    const quoterTotal = BigInt(String((qr as any).totalAmountOut));
    expect(userAssetOut, "exec vs quoter").to.equal(quoterTotal);
    expect(staticOut,     "static vs quoter").to.equal(quoterTotal);

    // After first call, router flips to NEG (next call will be ASSET-in)
    const flipped = await (router as any).getActiveOrbit(startPool);
    expect(Boolean(flipped[1])).to.equal(true);

    // Snapshot
    expect({
      role: "MCVQuoter",
      startWith: "POS",
      usingNeg: Boolean((qr as any).usingNeg),          // false
      assetToUsdc: Boolean((qr as any).assetToUsdc),    // false (USDC-in)
      amountIn: amountIn.toString(),
      fees: {
        perHopTotal: perHopFee.toString(),
        perHopTreasury: ((amountIn * TRE_CUT) / BPS).toString(),
        perHopPools: (perHopFee - (amountIn * TRE_CUT) / BPS).toString(),
      },
      orbit: (qr as any).orbit as string[],
      quoter: {
        perHop: ((qr as any).amountOutPerHop as bigint[]).map((x: any) => BigInt(String(x)).toString()),
        total: quoterTotal.toString(),
      },
      routerStatic: staticOut.toString(),
      execution: {
        userAssetOut: userAssetOut.toString(),
        hops: hopTrace,
      },
      pools: {
        before: poolsBefore,
        after:  poolsAfter,
      },
      flippedToNegAfter: Boolean((await (router as any).getActiveOrbit(startPool))[1]),
      note: "POS-first under dual-orbit; direction derived from set (USDC-in). Quoter == router.static == exec; three independent hops proven by events.",
    }).to.matchSnapshot("MCVQuoter — POS first (USDC-in) — quote==static==exec");
  });

  it("dual-orbit flips: after first call (NEG/ASSET-in) → POS/USDC-in; quotes & deltas snapshot", async () => {
    const env = await deployCore();
    const { deployer, router, factory, treasury, asset, usdc, access } = env as {
      deployer: any;
      router: LPPRouter;
      factory: LPPFactory;
      treasury: LPPTreasury;
      asset: TestERC20;
      usdc: TestERC20;
      access: LPPAccessManager;
    };

    await (await access.setApprovedSupplicator(deployer.address, true)).wait();

    const six = await ensureSixPools(factory, treasury, asset, usdc);
    await bootstrapSix(six, treasury);

    const startPool = six[0];
    await (
      await (treasury as any).setDualOrbitViaTreasury(
        await router.getAddress(),
        startPool,
        [six[0], six[1], six[2]], // NEG
        [six[3], six[4], six[5]], // POS
        /*startWithNeg*/ true
      )
    ).wait();

    const amountIn = ethers.parseEther("1");

    // ----- RUN #1: NEG / ASSET-in -----
    {
      const active0 = await (router as any).getActiveOrbit(startPool);
      const orbit0  = active0[0] as string[];
      expect(Boolean(active0[1])).to.equal(true); // NEG

      const pool0 = await ethers.getContractAt("LPPPool", orbit0[0]) as unknown as LPPPool;
      const tokens = await getTokensFromPool(pool0);

      const BPS = BigInt(await (router as any).BPS_DENOMINATOR());
      const MCV_FEE = BigInt(await (router as any).MCV_FEE_BPS());
      const perHopFee = (amountIn * MCV_FEE) / BPS;

      await (await env.asset.connect(deployer).mint(deployer.address, amountIn * 3n + perHopFee * 3n)).wait();
      await approveForMCV({ token: tokens.asset, payer: deployer, router, orbit: orbit0, amountIn });

      await (router.connect(deployer) as any).mcvSupplication({
        startPool,
        assetToUsdc: true,   // ignored (dual)
        amountIn,
        payer: deployer.address,
        to: deployer.address,
      });

      const flipped = await (router as any).getActiveOrbit(startPool);
      expect(Boolean(flipped[1])).to.equal(false); // now POS
    }

    // ----- RUN #2: POS / USDC-in (after flip) -----
    {
      const active1 = await (router as any).getActiveOrbit(startPool);
      const orbit1  = active1[0] as string[];
      expect(Boolean(active1[1])).to.equal(false); // POS

      const pool1 = await ethers.getContractAt("LPPPool", orbit1[0]) as unknown as LPPPool;
      const tokens = await getTokensFromPool(pool1);

      const BPS = BigInt(await (router as any).BPS_DENOMINATOR());
      const MCV_FEE = BigInt(await (router as any).MCV_FEE_BPS());
      const perHopFee = (amountIn * MCV_FEE) / BPS;

      await (await env.usdc.connect(deployer).mint(deployer.address, amountIn * 3n + perHopFee * 3n)).wait();
      await approveForMCV({ token: tokens.usdc, payer: deployer, router, orbit: orbit1, amountIn });

      // Quote via MCV quoter (should reflect POS / USDC-in)
      const QF = await ethers.getContractFactory("LPPQuoterMCV");
      const quoter = (await QF.deploy()) as unknown as LPPQuoterMCV;
      await quoter.waitForDeployment();

      const qr2 = await (quoter as any).quoteMCV(
        await router.getAddress(),
        startPool,
        amountIn,
        /*legacy*/ false // ignored (dual)
      );

      const staticOut2: bigint = await (router.connect(deployer) as any).mcvSupplication.staticCall({
        startPool,
        assetToUsdc: false,  // ignored (dual)
        amountIn,
        payer: deployer.address,
        to: deployer.address,
      });

      const tx2 = await (router.connect(deployer) as any).mcvSupplication({
        startPool,
        assetToUsdc: false,  // ignored (dual)
        amountIn,
        payer: deployer.address,
        to: deployer.address,
      });
      const rcpt2 = await tx2.wait();

      // Last known user balances (useful for snapshot context)
      const bA = await bal(tokens.asset, deployer.address);
      const bU = await bal(tokens.usdc,  deployer.address);

      expect({
        role: "MCVQuoter",
        flip: "NEG→POS",
        usingNegAfterFlip: Boolean((await (router as any).getActiveOrbit(startPool))[1]), // false (POS)
        quote: {
          usingNeg: Boolean(qr2.usingNeg),                 // false
          assetToUsdc: Boolean(qr2.assetToUsdc),           // false (USDC-in)
          total: toBig(qr2.totalAmountOut).toString(),
          perHop: (qr2.amountOutPerHop as bigint[]).map((x: any) => x.toString()),
        },
        routerStatic: staticOut2.toString(),
        lastKnownUserBalances: { asset: bA.toString(), usdc: bU.toString() },
        hops: (rcpt2?.logs ?? []).filter((l: any) => l.topics?.[0] === ethers.id("HopExecuted(address,bool,address,address,uint256,uint256)")).length,
        note: "Run #2 after set flip — POS set, USDC-in. Quoter and static must agree; events prove 3 hops.",
      }).to.matchSnapshot("MCVQuoter — POS after flip (USDC-in) — quote==static (+hop proof)");
    }
  });
});