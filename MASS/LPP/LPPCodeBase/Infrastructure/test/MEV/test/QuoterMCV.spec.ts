// test/MEV/test/QuoterMCV.spec.ts
import hre from "hardhat";
import { Wallet } from "ethers";
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

const HARDHAT_DEFAULT_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f094538cde44d9b1db7cbd4c116d5b1f20ad1d8c",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e652dfe2071fe3b043db68f6d7",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c3c1709e1b",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d82edb26a47ae4aa21",
  "0x4c2af20bcad0f27c8bd2c450b0e34ca2b30860639a42c4bb10368c110a02872e",
  "0x4df5e159dea613d5adad66b6edb2c27e3c75d4e463f981c710ddd7db2398f722",
  "0x6c2336b1f20da2691b6b6e7e0c9f9f5737de18f2d52b75bc93fdb6aa17f24a38",
  "0x86b5b4cd3e90d6f3ebfdcfd3c5c1355512cb786c3f0adf4adc0ebc1b82b5f29c",
  "0x8f94c6d344f07c035079847d9c7430f5bb5fd758d4c2dfd1f4cfad7d8c7b7fc8",
  "0x13e44d20cffa55ab5fd5920ab2f83ad1223f3ff4596d68e46052130f715cbd16",
  "0x7e62b5935fadd6a4cf4ef3a7606d5b9b5dffbe277d720e5b5066ef8dc8a3c75a",
  "0x95ced938f7991cd0dfcb48f0a06a40fa1af46ebbb0bbe06c6bbfdceb68e1d52f",
  "0x3e5e9111ae8bdc5cc18c0ba6f292f717532a64ef2ed4d131a6c26ee361f70a65",
  "0x2aa5a6bb8cc609f5470a24e03c657b79892c129e2b2f787c06a4f5a27ab1f0b6",
  "0x1c907fac9baa3319b8888dce884a6c2e3ef6a2fcf99b28729ff6cb298511fece",
  "0xa3895aae2b206a4ef4d568b4f903fb9c4080a99ac8093835b7e2df17cc6bcbfb",
  "0x0f4cfea9b63083812a0d8f030f84e9b03bc9425fc1469b7f8f1e8af0ea64a2c3",
  "0x5e3bf5df1a5d39668b203464ac515cd6b023e7a0d7b49853060c294d9f4cc5aa",
];

const HARDHAT_DEFAULT_ADDRESSES = HARDHAT_DEFAULT_KEYS.map((pk) =>
  new Wallet(pk).address.toLowerCase()
);

async function resolveWalletForSigner(signer: any): Promise<Wallet> {
  if (typeof signer.privateKey === "string") {
    return new Wallet(signer.privateKey, ethers.provider);
  }

  const targetAddr = (await signer.getAddress()).toLowerCase();
  const accountsConfig = hre.network.config.accounts;

  if (Array.isArray(accountsConfig)) {
    for (const pk of accountsConfig as string[]) {
      const wallet = new Wallet(pk);
      if (wallet.address.toLowerCase() === targetAddr) {
        return wallet.connect(ethers.provider);
      }
    }
  }

  const idx = HARDHAT_DEFAULT_ADDRESSES.indexOf(targetAddr);
  if (idx >= 0) {
    return new Wallet(HARDHAT_DEFAULT_KEYS[idx], ethers.provider);
  }

  throw new Error(`Unable to resolve private key for signer ${targetAddr}`);
}

async function buildSignedSwapTx(
  signer: any,
  router: LPPRouter,
  params: SwapParams,
  gasLimit: bigint = 750_000n
): Promise<string> {
  const populated = await (router.connect(signer) as any).swap.populateTransaction(params);
  const signerAddr = typeof signer.getAddress === "function" ? await signer.getAddress() : signer.address;
  const nonce = await ethers.provider.getTransactionCount(signerAddr, "pending");
  const feeData = await ethers.provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? ethers.parseUnits("30", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("2", "gwei");
  const network = await ethers.provider.getNetwork();

  const wallet = await resolveWalletForSigner(signer);
  if (!wallet) {
    throw new Error("Unable to resolve private key for signer");
  }

  return await wallet.signTransaction({
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
  const blockNum = await ethers.provider.getBlockNumber();
  const targetBlock = `0x${(blockNum + 1).toString(16)}`;

  const bundleResult = await submitBundleViaMevShare(harness, {
    version: "v0.1",
    inclusion: { block: targetBlock },
    body: [{ tx: signedTx, canRevert: false }],
  });

  expect(bundleResult.success, "MEV relay should accept bundle").to.equal(true);

  await ethers.provider.send("evm_setAutomine", [false]);
  try {
    const txResponse = await ethers.provider.broadcastTransaction(signedTx);
    await ethers.provider.send("evm_mine", []);
    const receipt = await txResponse.wait();
    return { receipt, bundleHash: bundleResult.bundleHash, targetBlock };
  } finally {
    await ethers.provider.send("evm_setAutomine", [true]);
  }

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

    // Get NEG orbit (searcher chooses NEG orbit via assetToUsdc=true)
    const dualOrbit = await (router as any).getDualOrbit(startPool);
    const orbit0  = Array.from(dualOrbit[0] as readonly string[]); // NEG orbit
    const usingNeg0 = true; // Searcher chooses NEG orbit

    const pool0 = await ethers.getContractAt("LPPPool", orbit0[0]) as unknown as LPPPool;
    const tokens = await getTokensFromPool(pool0);

    // fee constants from router
    const BPS = BigInt(await (router as any).BPS_DENOMINATOR());
    const MCV_FEE = BigInt(await (router as any).MCV_FEE_BPS());
    const TRE_CUT = BigInt(await (router as any).TREASURY_CUT_BPS());
    const perHopFee = (amountIn * MCV_FEE) / BPS;
    const numHops = BigInt(orbit0.length);
    const feeAll    = perHopFee * numHops;

    // fund + approvals (ASSET-in)
    await (await (env.asset as TestERC20).connect(deployer).mint(deployer.address, amountIn * numHops + feeAll)).wait();
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
      note: "Searcher chooses NEG orbit (ASSET-in). Quote via provider.call; no Contract.swap() arg walker.",
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

    // Get POS orbit (searcher chooses POS orbit via assetToUsdc=false)
    const dualOrbit = await (router as any).getDualOrbit(startPool);
    const orbit0  = Array.from(dualOrbit[1] as readonly string[]); // POS orbit
    const usingNeg0 = false; // Searcher chooses POS orbit

    const pool0 = await ethers.getContractAt("LPPPool", orbit0[0]) as unknown as LPPPool;
    const tokens = await getTokensFromPool(pool0);

    const BPS = BigInt(await (router as any).BPS_DENOMINATOR());
    const MCV_FEE = BigInt(await (router as any).MCV_FEE_BPS());
    const TRE_CUT = BigInt(await (router as any).TREASURY_CUT_BPS());
    const perHopFee = (amountIn * MCV_FEE) / BPS;
    const numHops = BigInt(orbit0.length);
    const totalFee  = perHopFee * numHops;

    await (await (env.usdc as TestERC20).connect(deployer).mint(deployer.address, amountIn * numHops + totalFee)).wait();
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

    // Pools in POS orbit should have flipped offsets (from +500 to -500)
    const offsetsAfter = await Promise.all(orbit0.map(async (addr) => {
      const pool = await ethers.getContractAt("LPPPool", addr);
      return (await pool.targetOffsetBps()).toString();
    }));
    expect(offsetsAfter.every(o => o === "-500")).to.be.true;

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
      poolOffsetsFlipped: true,
      note: "Searcher chooses POS orbit; pool offsets flip after swap. Raw provider.call for quote, raw tx for exec.",
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

    // ----- RUN #1: NEG / ASSET-in - Searcher chooses NEG orbit -----
    {
      const dualOrbit = await (router as any).getDualOrbit(startPool);
      const orbit0  = Array.from(dualOrbit[0] as readonly string[]); // NEG orbit
      
      // Check initial offsets (should be -500)
      const offsetsBefore1 = await Promise.all(orbit0.map(async (addr) => {
        const pool = await ethers.getContractAt("LPPPool", addr);
        return (await pool.targetOffsetBps()).toString();
      }));
      expect(offsetsBefore1.every(o => o === "-500")).to.be.true;

      const pool0 = await ethers.getContractAt("LPPPool", orbit0[0]) as unknown as LPPPool;
      const tokens = await getTokensFromPool(pool0);

      const BPS = BigInt(await (router as any).BPS_DENOMINATOR());
      const MCV_FEE = BigInt(await (router as any).MCV_FEE_BPS());
      const perHopFee = (amountIn * MCV_FEE) / BPS;
      const numHops = BigInt(orbit0.length);

      await (await (env.asset as TestERC20).connect(deployer).mint(deployer.address, amountIn * numHops + perHopFee * numHops)).wait();
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

      // Pools in NEG orbit should have flipped offsets (from -500 to +500)
      const offsetsAfter1 = await Promise.all(orbit0.map(async (addr) => {
        const pool = await ethers.getContractAt("LPPPool", addr);
        return (await pool.targetOffsetBps()).toString();
      }));
      expect(offsetsAfter1.every(o => o === "500")).to.be.true;
      expect(staticA >= 0n).to.equal(true);
    }

    // ----- RUN #2: POS / USDC-in - Searcher chooses POS orbit -----
    {
      const dualOrbit = await (router as any).getDualOrbit(startPool);
      const orbit1  = Array.from(dualOrbit[1] as readonly string[]); // POS orbit
      
      // Check initial offsets (should be +500)
      const offsetsBefore2 = await Promise.all(orbit1.map(async (addr) => {
        const pool = await ethers.getContractAt("LPPPool", addr);
        return (await pool.targetOffsetBps()).toString();
      }));
      expect(offsetsBefore2.every(o => o === "500")).to.be.true;

      const pool1 = await ethers.getContractAt("LPPPool", orbit1[0]) as unknown as LPPPool;
      const tokens = await getTokensFromPool(pool1);

      const BPS = BigInt(await (router as any).BPS_DENOMINATOR());
      const MCV_FEE = BigInt(await (router as any).MCV_FEE_BPS());
      const perHopFee = (amountIn * MCV_FEE) / BPS;
      const numHops = BigInt(orbit1.length);

      await (await (env.usdc as TestERC20).connect(deployer).mint(deployer.address, amountIn * numHops + perHopFee * numHops)).wait();
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

      // Pools in POS orbit should have flipped offsets (from +500 to -500)
      const offsetsAfter2 = await Promise.all(orbit1.map(async (addr) => {
        const pool = await ethers.getContractAt("LPPPool", addr);
        return (await pool.targetOffsetBps()).toString();
      }));
      expect(offsetsAfter2.every(o => o === "-500")).to.be.true;

      expect({
        role: "MCV — searcher-quote",
        flip: "NEG→POS (searcher chooses)",
        poolOffsetsFlipped: true,
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