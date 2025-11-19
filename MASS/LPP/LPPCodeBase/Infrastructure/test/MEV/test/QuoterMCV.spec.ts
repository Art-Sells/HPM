// test/QuoterMCV.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import { deployCore, setupDualMevOrbit } from "./helpers.ts";

import type {
  IERC20,
  TestERC20,
  LPPPool,
  LPPRouter,
  LPPAccessManager,
} from "../../../typechain-types/index.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * Direction Policy (derived from active set):
 *   NEG set  => ASSET-in (ASSET -> USDC)
 *   POS set  => USDC-in  (USDC  -> ASSET)
 * No independent direction cursor is used.
 * Searcher quote = router.swap.staticCall (eth_call).
 * ──────────────────────────────────────────────────────────────────────────── */

const IERC20_FQN = "contracts/external/IERC20.sol:IERC20";
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

/** MEV-style quote: a dry-run eth_call to the router.swap */
async function searcherQuoteStatic(
  router: LPPRouter,
  startPool: string,
  assetToUsdcDerived: boolean,
  amountIn: bigint,
  payer: string,
  to: string
): Promise<bigint> {
  return await (router as any).swap.staticCall({
    startPool,
    assetToUsdc: assetToUsdcDerived, // ignored by router when dual-orbit is set; kept for ABI shape
    amountIn,
    payer,
    to,
    minTotalAmountOut: 0n,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Spec
 * ──────────────────────────────────────────────────────────────────────────── */

describe("MCV — searcher-style quoting (no Quoter; eth_call only)", () => {
  it("NEG set first (ASSET-in derived) — static == exec; snapshots", async () => {
    const env = await deployCore();
    const { deployer, router, asset, usdc, access } = env as {
      deployer: any;
      router: LPPRouter;
      asset: TestERC20;
      usdc: TestERC20;
      access: LPPAccessManager;
    };

    // allow deployer for single-pool supplicate (not needed for swap but harmless)
    await (await access.setApprovedSupplicator(deployer.address, true)).wait();

    const { startPool } = await setupDualMevOrbit(env, { startWithNeg: true });

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

    // === Searcher quote (eth_call) ===
    const staticOut = await searcherQuoteStatic(
      router,
      startPool,
      /*assetToUsdcDerived*/ true,
      amountIn,
      deployer.address,
      deployer.address
    );

    // Execute
    const tx = await (router.connect(deployer) as any).swap({
      startPool,
      assetToUsdc: true,  // ignored (dual)
      amountIn,
      payer: deployer.address,
      to: deployer.address,
      minTotalAmountOut: 0n,
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
        // indexed topics: [0]=sig, [1]=pool, [2]=tokenIn, [3]=tokenOut
        const pool     = ethers.getAddress("0x" + l.topics[1].slice(26));
        const tokenIn  = ethers.getAddress("0x" + l.topics[2].slice(26));
        const tokenOut = ethers.getAddress("0x" + l.topics[3].slice(26));

        // data = non-indexed: [bool assetToUsdc, uint256 amountIn, uint256 amountOut]
        const [assetToUsdc, amtIn, amtOut] =
          ethers.AbiCoder.defaultAbiCoder().decode(
            ["bool","uint256","uint256"],
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

    // Assertions: static == exec (sum of hop outs)
    expect(userUsdcOut, "exec vs static (searcher quote)").to.equal(staticOut);

    // Snapshot object
    expect({
      role: "MCV — searcher-quote",
      usingNeg: usingNeg0,                          // true
      assetToUsdc: true,                            // ASSET->USDC
      amountIn: amountIn.toString(),
      fees: {
        perHopTotal: perHopFee.toString(),
        perHopTreasury: ((amountIn * TRE_CUT) / BPS).toString(),
        perHopPools: (perHopFee - (amountIn * TRE_CUT) / BPS).toString(),
      },
      orbit: orbit0,
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
      note: "NEG set, ASSET-in. Quote is eth_call to router.swap (no Quoter).",
    }).to.matchSnapshot("MCV — NEG first (ASSET-in) — static==exec (+hop proof)");
  });

  it("POS set first (USDC-in derived) — static == exec; snapshots", async () => {
    const env = await deployCore();
    const { deployer, router, asset, usdc, access } = env as {
      deployer: any;
      router: LPPRouter;
      asset: TestERC20;
      usdc: TestERC20;
      access: LPPAccessManager;
    };

    await (await access.setApprovedSupplicator(deployer.address, true)).wait();

    const { startPool } = await setupDualMevOrbit(env, { startWithNeg: false });

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

    // === Searcher quote (eth_call) ===
    const staticOut = await searcherQuoteStatic(
      router,
      startPool,
      /*assetToUsdcDerived*/ false,
      amountIn,
      deployer.address,
      deployer.address
    );

    // Execute
    const tx = await (router.connect(deployer) as any).swap({
      startPool,
      assetToUsdc: false,  // ignored (dual)
      amountIn,
      payer: deployer.address,
      to: deployer.address,
      minTotalAmountOut: 0n,
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
        const pool     = ethers.getAddress("0x" + l.topics[1].slice(26));
        const tokenIn  = ethers.getAddress("0x" + l.topics[2].slice(26));
        const tokenOut = ethers.getAddress("0x" + l.topics[3].slice(26));

        const [assetToUsdc, amtIn, amtOut] =
          ethers.AbiCoder.defaultAbiCoder().decode(
            ["bool","uint256","uint256"],
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
    expect(userAssetOut, "exec vs static (searcher quote)").to.equal(staticOut);

    // After first call, router flips to NEG (next call will be ASSET-in)
    const flipped = await (router as any).getActiveOrbit(startPool);
    expect(Boolean(flipped[1])).to.equal(true);

    // Snapshot
    expect({
      role: "MCV — searcher-quote",
      startWith: "POS",
      usingNeg: usingNeg0,                     // false
      assetToUsdc: false,                      // USDC->ASSET
      amountIn: amountIn.toString(),
      fees: {
        perHopTotal: perHopFee.toString(),
        perHopTreasury: ((amountIn * TRE_CUT) / BPS).toString(),
        perHopPools: (perHopFee - (amountIn * TRE_CUT) / BPS).toString(),
      },
      orbit: orbit0,
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
      note: "POS-first under dual-orbit; quote is eth_call to router (no Quoter).",
    }).to.matchSnapshot("MCV — POS first (USDC-in) — static==exec (+hop proof)");
  });

  it("dual-orbit flips: after first call (NEG/ASSET-in) → POS/USDC-in; static & deltas snapshot", async () => {
    const env = await deployCore();
    const { deployer, router, asset, usdc, access } = env as {
      deployer: any;
      router: LPPRouter;
      asset: TestERC20;
      usdc: TestERC20;
      access: LPPAccessManager;
    };

    await (await access.setApprovedSupplicator(deployer.address, true)).wait();

    const { startPool } = await setupDualMevOrbit(env, { startWithNeg: true });

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

      // searcher quote (NEG/ASSET-in)
      const staticA = await searcherQuoteStatic(
        router, startPool, true, amountIn, deployer.address, deployer.address
      );

      // exec
      await (router.connect(deployer) as any).swap({
        startPool,
        assetToUsdc: true,   // ignored (dual)
        amountIn,
        payer: deployer.address,
        to: deployer.address,
        minTotalAmountOut: 0n,
      });

      // flip happened?
      const flipped = await (router as any).getActiveOrbit(startPool);
      expect(Boolean(flipped[1])).to.equal(false); // now POS

      // keep the staticA around only for context in snapshot below
      expect(staticA >= 0n).to.equal(true);
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

      // Quote via MEV-style static
      const staticOut2 = await searcherQuoteStatic(
        router, startPool, false, amountIn, deployer.address, deployer.address
      );

      const tx2 = await (router.connect(deployer) as any).swap({
        startPool,
        assetToUsdc: false,  // ignored (dual)
        amountIn,
        payer: deployer.address,
        to: deployer.address,
        minTotalAmountOut: 0n,
      });
      const rcpt2 = await tx2.wait();

      // Last known balances (context)
      const bA = await bal(tokens.asset, deployer.address);
      const bU = await bal(tokens.usdc,  deployer.address);

      expect({
        role: "MCV — searcher-quote",
        flip: "NEG→POS",
        usingNegAfterFlip: Boolean((await (router as any).getActiveOrbit(startPool))[1]), // false (POS)
        routerStatic: staticOut2.toString(),
        lastKnownUserBalances: { asset: bA.toString(), usdc: bU.toString() },
        hops: (rcpt2?.logs ?? []).filter((l: any) => l.topics?.[0] === ethers.id("HopExecuted(address,bool,address,address,uint256,uint256)")).length,
        note: "Run #2 after set flip — POS set, USDC-in. Quote is eth_call to router; events prove 3 hops.",
      }).to.matchSnapshot("MCV — POS after flip (USDC-in) — static (+hop proof)");
    }
  });
});