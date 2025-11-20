// test/MEV/test/QuoterMCV.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import {
  deployCore,
  setupDualMevOrbit,
  startMevHarness,
  cleanupMevHarness,
  submitBundleViaMevShare,
  type MevHarness,
} from "./helpers.ts";

import { exec as execCallback } from "child_process";
import { promisify } from "util";
const exec = promisify(execCallback);

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
 * Searcher quote = raw provider.call to router.swap selector (no Contract.swap()).
 * ──────────────────────────────────────────────────────────────────────────── */

const IERC20_FQN = "contracts/external/IERC20.sol:IERC20";

type SwapParams = {
  startPool: string;
  assetToUsdc: boolean;
  amountIn: bigint;
  minTotalAmountOut: bigint;
  to: string;
  payer: string;
};

async function buildSignedSwapTx(
  signer: any,
  router: LPPRouter,
  params: SwapParams,
  gasLimit: bigint = 750_000n
): Promise<string> {
  const populated = await (router.connect(signer) as any).swap.populateTransaction(params);
  const signerAddr = typeof signer.getAddress === "function" ? await signer.getAddress() : signer.address;
  const nonce = await ethers.provider.getTransactionCount(signerAddr);
  const feeData = await ethers.provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? ethers.parseUnits("30", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("2", "gwei");
  const network = await ethers.provider.getNetwork();

  return await signer.signTransaction({
    to: populated.to ?? (await router.getAddress()),
    data: populated.data,
    gasLimit: populated.gasLimit ?? gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce,
    type: 2,
    value: populated.value ?? 0n,
    chainId: network.chainId,
  });
}

async function submitBundleAndExecuteSwap(
  harness: MevHarness,
  signedTx: string
): Promise<{ receipt: any; bundleHash: string; targetBlock: string }> {
  const currentBlock = await ethers.provider.getBlockNumber();
  const targetBlock = `0x${(currentBlock + 1).toString(16)}`;

  const bundleResult = await submitBundleViaMevShare(harness, {
    version: "v0.1",
    inclusion: { block: targetBlock },
    body: [{ tx: signedTx, canRevert: false }],
  });

  expect(bundleResult.success, "MEV relay should accept bundle").to.equal(true);

  const txResponse = await ethers.provider.broadcastTransaction(signedTx);
  const receipt = await txResponse.wait();

  return { receipt, bundleHash: bundleResult.bundleHash, targetBlock };
}

async function staticQuoteRaw(
  router: LPPRouter,
  params: SwapParams
): Promise<bigint> {
  const data = router.interface.encodeFunctionData("swap", [params]);
  const ret = await ethers.provider.call({ to: await router.getAddress(), data });
  const [out] = router.interface.decodeFunctionResult("swap", ret);
  return BigInt(out.toString());
}

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

/* ────────────────────────────────────────────────────────────────────────────
 * Spec
 * ──────────────────────────────────────────────────────────────────────────── */

describe("MCV — searcher-style quoting (no Quoter; eth_call only)", () => {
  let harness: MevHarness | null = null;

  before(async () => {
    if (harness) return;
    await exec("go version");

    const netCfg = hre.network.config as { url?: string };
    const rpcUrl = netCfg?.url ?? "http://127.0.0.1:8545";
    harness = await startMevHarness(rpcUrl);
  });

  after(async () => {
    if (harness) {
      await cleanupMevHarness();
      harness = null;
    }
  });

  it("NEG set first (ASSET-in derived) — static == exec; snapshots", async () => {
    const env = await deployCore();
    const { deployer, router, access } = env as {
      deployer: any;
      router: LPPRouter;
      access: LPPAccessManager;
    };

    await (await access.setApprovedSupplicator(deployer.address, true)).wait();

    const { startPool } = await setupDualMevOrbit(env, { startWithNeg: true });

    const amountIn = ethers.parseEther("1");

    // read active orbit (clone ethers.Result → plain array)
    const active0 = await (router as any).getActiveOrbit(startPool);
    const orbit0  = Array.from(active0[0] as readonly string[]);
    const usingNeg0 = Boolean(active0[1]);
    expect(usingNeg0).to.equal(true); // NEG ⇒ ASSET-in

    const pool0 = await ethers.getContractAt("LPPPool", orbit0[0]) as unknown as LPPPool;
    const tokens = await getTokensFromPool(pool0);

    // fee constants from router
    const BPS = BigInt(await (router as any).BPS_DENOMINATOR());
    const MCV_FEE = BigInt(await (router as any).MCV_FEE_BPS());
    const TRE_CUT = BigInt(await (router as any).TREASURY_CUT_BPS());
    const perHopFee = (amountIn * MCV_FEE) / BPS;
    const feeAll    = perHopFee * 3n;

    // fund + approvals (ASSET-in)
    await (await (env.asset as TestERC20).connect(deployer).mint(deployer.address, amountIn * 3n + feeAll)).wait();
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

    const params: SwapParams = {
      startPool,
      assetToUsdc: true,
      amountIn,
      minTotalAmountOut: 0n,
      to: deployer.address,
      payer: deployer.address,
    };

    // === Searcher quote (raw provider.call) ===
    const staticOut = await staticQuoteRaw(router, params);

    if (!harness) {
      throw new Error("MEV harness not initialized");
    }

    const signedTx = await buildSignedSwapTx(deployer, router, params);
    const { receipt, bundleHash } = await submitBundleAndExecuteSwap(harness, signedTx);

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
    const userAssetDec   = b0A - a1;

    // Parse HopExecuted events
    const HopExecutedSig = ethers.id("HopExecuted(address,bool,address,address,uint256,uint256)");
    const hopTrace = (receipt?.logs ?? [])
      .filter((l: any) => l.topics && l.topics[0] === HopExecutedSig)
      .map((l: any) => {
        const pool     = ethers.getAddress("0x" + l.topics[1].slice(26));
        const tokenIn  = ethers.getAddress("0x" + l.topics[2].slice(26));
        const tokenOut = ethers.getAddress("0x" + l.topics[3].slice(26));
        const [assetToUsdc, amtIn, amtOut] =
          ethers.AbiCoder.defaultAbiCoder().decode(["bool","uint256","uint256"], l.data);
        return {
          pool,
          assetToUsdc: Boolean(assetToUsdc),
          amountIn: toBig(amtIn).toString(),
          amountOut: toBig(amtOut).toString(),
          tokenIn,
          tokenOut,
        };
      });

    expect(userUsdcOut, "exec vs static (searcher quote)").to.equal(staticOut);

    expect({
      role: "MCV — searcher-quote",
      usingNeg: usingNeg0,
      assetToUsdc: true,
      amountIn: amountIn.toString(),
      fees: {
        perHopTotal: perHopFee.toString(),
        perHopTreasury: ((amountIn * TRE_CUT) / BPS).toString(),
        perHopPools: (perHopFee - (amountIn * TRE_CUT) / BPS).toString(),
      },
      orbit: orbit0,
      routerStatic: staticOut.toString(),
      bundle: {
        protocol: "mev-share",
        hash: bundleHash ?? "",
      },
      execution: {
        userUsdcOut: userUsdcOut.toString(),
        userAssetDecrease: userAssetDec.toString(),
        hops: hopTrace,
      },
      pools: { before: poolsBefore, after:  poolsAfter },
      note: "NEG set, ASSET-in. Quote via provider.call; no Contract.swap() arg walker.",
    }).to.matchSnapshot("MCV — NEG first (ASSET-in) — static==exec (+hop proof)");
  });

  it("POS set first (USDC-in derived) — static == exec; snapshots", async () => {
    const env = await deployCore();
    const { deployer, router, access } = env as {
      deployer: any;
      router: LPPRouter;
      access: LPPAccessManager;
    };

    await (await access.setApprovedSupplicator(deployer.address, true)).wait();

    const { startPool } = await setupDualMevOrbit(env, { startWithNeg: false });

    const amountIn = ethers.parseEther("1");

    // POS ⇒ USDC-in (clone Result)
    const active0 = await (router as any).getActiveOrbit(startPool);
    const orbit0  = Array.from(active0[0] as readonly string[]);
    const usingNeg0 = Boolean(active0[1]);
    expect(usingNeg0).to.equal(false);

    const pool0 = await ethers.getContractAt("LPPPool", orbit0[0]) as unknown as LPPPool;
    const tokens = await getTokensFromPool(pool0);

    const BPS = BigInt(await (router as any).BPS_DENOMINATOR());
    const MCV_FEE = BigInt(await (router as any).MCV_FEE_BPS());
    const TRE_CUT = BigInt(await (router as any).TREASURY_CUT_BPS());
    const perHopFee = (amountIn * MCV_FEE) / BPS;
    const totalFee  = perHopFee * 3n;

    await (await (env.usdc as TestERC20).connect(deployer).mint(deployer.address, amountIn * 3n + totalFee)).wait();
    await approveForMCV({ token: tokens.usdc, payer: deployer, router, orbit: orbit0, amountIn });

    const poolsBefore = await Promise.all(
      orbit0.map(async (addr) => {
        const p = await ethers.getContractAt("LPPPool", addr) as unknown as LPPPool;
        const a = BigInt((await p.reserveAsset()).toString());
        const u = BigInt((await p.reserveUsdc()).toString());
        return { pool: addr, a: a.toString(), u: u.toString() };
      })
    );
    const b0A = BigInt((await (tokens.asset as any).balanceOf(deployer.address)).toString());
    const b0U = BigInt((await (tokens.usdc as any).balanceOf(deployer.address)).toString());

    const params: SwapParams = {
      startPool,
      assetToUsdc: false,
      amountIn,
      minTotalAmountOut: 0n,
      to: deployer.address,
      payer: deployer.address,
    };

    const staticOut = await staticQuoteRaw(router, params);

    if (!harness) {
      throw new Error("MEV harness not initialized");
    }

    const signedTx = await buildSignedSwapTx(deployer, router, params);
    const { receipt, bundleHash } = await submitBundleAndExecuteSwap(harness, signedTx);

    const poolsAfter = await Promise.all(
      orbit0.map(async (addr) => {
        const p = await ethers.getContractAt("LPPPool", addr) as unknown as LPPPool;
        const a = BigInt((await p.reserveAsset()).toString());
        const u = BigInt((await p.reserveUsdc()).toString());
        return { pool: addr, a: a.toString(), u: u.toString() };
      })
    );
    const a1 = BigInt((await (tokens.asset as any).balanceOf(deployer.address)).toString());
    const u1 = BigInt((await (tokens.usdc as any).balanceOf(deployer.address)).toString());
    const userAssetOut = a1 > b0A ? a1 - b0A : 0n;

    const HopExecutedSig = ethers.id("HopExecuted(address,bool,address,address,uint256,uint256)");
    const hopTrace = (receipt?.logs ?? [])
      .filter((l: any) => l.topics?.[0] === HopExecutedSig)
      .map((l: any) => {
        const pool     = ethers.getAddress("0x" + l.topics[1].slice(26));
        const tokenIn  = ethers.getAddress("0x" + l.topics[2].slice(26));
        const tokenOut = ethers.getAddress("0x" + l.topics[3].slice(26));
        const [assetToUsdc, amtIn, amtOut] =
          ethers.AbiCoder.defaultAbiCoder().decode(["bool","uint256","uint256"], l.data);
        return {
          pool,
          assetToUsdc: Boolean(assetToUsdc),
          amountIn: BigInt(String(amtIn)).toString(),
          amountOut: BigInt(String(amtOut)).toString(),
          tokenIn,
          tokenOut,
        };
      });

    expect(userAssetOut, "exec vs static (searcher quote)").to.equal(staticOut);

    const flipped = await (router as any).getActiveOrbit(startPool);
    expect(Boolean(flipped[1])).to.equal(true);

    expect({
      role: "MCV — searcher-quote",
      startWith: "POS",
      usingNeg: usingNeg0,
      assetToUsdc: false,
      amountIn: amountIn.toString(),
      fees: {
        perHopTotal: perHopFee.toString(),
        perHopTreasury: ((amountIn * TRE_CUT) / BPS).toString(),
        perHopPools: (perHopFee - (amountIn * TRE_CUT) / BPS).toString(),
      },
      orbit: orbit0,
      routerStatic: staticOut.toString(),
      bundle: {
        protocol: "mev-share",
        hash: bundleHash ?? "",
      },
      execution: {
        userAssetOut: userAssetOut.toString(),
        hops: hopTrace,
      },
      pools: { before: poolsBefore, after:  poolsAfter },
      flippedToNegAfter: Boolean((await (router as any).getActiveOrbit(startPool))[1]),
      note: "POS-first under dual-orbit; raw provider.call for quote, raw tx for exec.",
    }).to.matchSnapshot("MCV — POS first (USDC-in) — static==exec (+hop proof)");
  });

  it("dual-orbit flips: after first call (NEG/ASSET-in) → POS/USDC-in; static & deltas snapshot", async () => {
    const env = await deployCore();
    const { deployer, router, access } = env as {
      deployer: any;
      router: LPPRouter;
      access: LPPAccessManager;
    };

    await (await access.setApprovedSupplicator(deployer.address, true)).wait();

    const { startPool } = await setupDualMevOrbit(env, { startWithNeg: true });
    const amountIn = ethers.parseEther("1");

    let bundleHashNeg = "";
    let bundleHashPos = "";

    // ----- RUN #1: NEG / ASSET-in -----
    {
      const active0 = await (router as any).getActiveOrbit(startPool);
      const orbit0  = Array.from(active0[0] as readonly string[]);
      expect(Boolean(active0[1])).to.equal(true);

      const pool0 = await ethers.getContractAt("LPPPool", orbit0[0]) as unknown as LPPPool;
      const tokens = await getTokensFromPool(pool0);

      const BPS = BigInt(await (router as any).BPS_DENOMINATOR());
      const MCV_FEE = BigInt(await (router as any).MCV_FEE_BPS());
      const perHopFee = (amountIn * MCV_FEE) / BPS;

      await (await (env.asset as TestERC20).connect(deployer).mint(deployer.address, amountIn * 3n + perHopFee * 3n)).wait();
      await approveForMCV({ token: tokens.asset, payer: deployer, router, orbit: orbit0, amountIn });

      const negParams: SwapParams = {
        startPool,
        assetToUsdc: true,
        amountIn,
        minTotalAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      };
      const staticA = await staticQuoteRaw(router, negParams);

      if (!harness) {
        throw new Error("MEV harness not initialized");
      }

      const signedTxNeg = await buildSignedSwapTx(deployer, router, negParams);
      const submission = await submitBundleAndExecuteSwap(harness, signedTxNeg);
      bundleHashNeg = submission.bundleHash ?? "";

      const flipped = await (router as any).getActiveOrbit(startPool);
      expect(Boolean(flipped[1])).to.equal(false);
      expect(staticA >= 0n).to.equal(true);
    }

    // ----- RUN #2: POS / USDC-in -----
    {
      const active1 = await (router as any).getActiveOrbit(startPool);
      const orbit1  = Array.from(active1[0] as readonly string[]);
      expect(Boolean(active1[1])).to.equal(false);

      const pool1 = await ethers.getContractAt("LPPPool", orbit1[0]) as unknown as LPPPool;
      const tokens = await getTokensFromPool(pool1);

      const BPS = BigInt(await (router as any).BPS_DENOMINATOR());
      const MCV_FEE = BigInt(await (router as any).MCV_FEE_BPS());
      const perHopFee = (amountIn * MCV_FEE) / BPS;

      await (await (env.usdc as TestERC20).connect(deployer).mint(deployer.address, amountIn * 3n + perHopFee * 3n)).wait();
      await approveForMCV({ token: tokens.usdc, payer: deployer, router, orbit: orbit1, amountIn });

      const posParams: SwapParams = {
        startPool,
        assetToUsdc: false,
        amountIn,
        minTotalAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      };
      const staticOut2 = await staticQuoteRaw(router, posParams);

      if (!harness) {
        throw new Error("MEV harness not initialized");
      }

      const signedTxPos = await buildSignedSwapTx(deployer, router, posParams);
      const { receipt: rcpt2, bundleHash } = await submitBundleAndExecuteSwap(harness, signedTxPos);
      bundleHashPos = bundleHash ?? "";

      const bA = await bal((await getTokensFromPool(await ethers.getContractAt("LPPPool", orbit1[0]) as unknown as LPPPool)).asset, deployer.address);
      const bU = await bal((await getTokensFromPool(await ethers.getContractAt("LPPPool", orbit1[0]) as unknown as LPPPool)).usdc,  deployer.address);

      expect({
        role: "MCV — searcher-quote",
        flip: "NEG→POS",
        usingNegAfterFlip: Boolean((await (router as any).getActiveOrbit(startPool))[1]),
        routerStatic: staticOut2.toString(),
        lastKnownUserBalances: { asset: bA.toString(), usdc: bU.toString() },
        hops: (rcpt2?.logs ?? []).filter((l: any) => l.topics?.[0] === ethers.id("HopExecuted(address,bool,address,address,uint256,uint256)")).length,
        bundleHashes: {
          neg: bundleHashNeg,
          pos: bundleHashPos,
        },
        note: "Run #2 after flip — POS, USDC-in. Quote/exec via raw ABI; no argument mutation.",
      }).to.matchSnapshot("MCV — POS after flip (USDC-in) — static (+hop proof)");
    }
  });
});