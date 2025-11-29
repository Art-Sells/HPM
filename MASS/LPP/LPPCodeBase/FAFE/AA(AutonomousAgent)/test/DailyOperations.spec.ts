// AA(AutonomousAgent)/test/DailyOperations.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "../../test/shared/expect.ts";
import {
  deployCore,
  ensureSixPools,
  bootstrapMany,
  setDedicatedAA,
  runDeposit,
  approveMax,
} from "../../test/helpers.ts";

import type {
  TestERC20,
  FAFERouter,
  FAFEAccessManager,
  FAFETreasury,
  FAFEFactory,
} from "../../typechain-types/index.ts";

type AAEnv = {
  deployer: any;
  treasuryOps: any;
  aa: any;
  router: FAFERouter;
  factory: FAFEFactory;
  access: FAFEAccessManager;
  treasury: FAFETreasury;
  asset: TestERC20;
  usdc: TestERC20;
  pools: string[];
};

type BorrowLog = {
  pool: string;
  token: "ASSET" | "USDC";
  amount: string;
};

type ProfitDepositLog = {
  pool: string;
  token: "ASSET" | "USDC";
  amount: string;
  treasuryCut: string;
  poolAmount: string;
};

type RebalanceLog = {
  sourcePool: string;
  destPool: string;
  token: "ASSET" | "USDC";
  amount: string;
};

type DailyLog = {
  borrows: BorrowLog[];
  profitDeposits: ProfitDepositLog[];
  rebalances: RebalanceLog[];
  completed: boolean;
};

const ASSET_DECIMALS = 8;
const USDC_DECIMALS = 6;

async function setupAAEnvironment(): Promise<AAEnv> {
  const [deployer, treasuryOps, aa] = await ethers.getSigners();
  const core = await deployCore();
  await setDedicatedAA(core.treasury, core.access, aa.address, deployer);

  const pools = await ensureSixPools(core.factory, core.treasury, core.asset, core.usdc);
  const offsets = [-5000, -5000, -5000, 5000, 5000, 5000];

  const bootstrapAsset = ethers.parseUnits("2", ASSET_DECIMALS);
  const bootstrapUsdc = ethers.parseUnits("2", USDC_DECIMALS);
  const treasuryAddr = await core.treasury.getAddress();

  await (await core.asset.connect(deployer).mint(treasuryAddr, bootstrapAsset * 6n)).wait();
  await (await core.usdc.connect(deployer).mint(treasuryAddr, bootstrapUsdc * 6n)).wait();

  await bootstrapMany(
    core.treasury,
    pools,
    core.asset,
    core.usdc,
    bootstrapAsset,
    bootstrapUsdc,
    offsets
  );

  return {
    deployer,
    treasuryOps,
    aa,
    router: core.router,
    factory: core.factory,
    access: core.access,
    treasury: core.treasury,
    asset: core.asset,
    usdc: core.usdc,
    pools,
  };
}

async function getPoolReserves(poolAddr: string) {
  const pool = await ethers.getContractAt("FAFEPool", poolAddr);
  return {
    asset: BigInt((await pool.reserveAsset()).toString()),
    usdc: BigInt((await pool.reserveUsdc()).toString()),
  };
}

async function runRebalanceScan(env: AAEnv, dailyLog: DailyLog) {
  const { aa, router, factory } = env;
  const pools = await factory.getPools();

  for (let i = 0; i < pools.length; i++) {
    for (let j = i + 1; j < pools.length; j++) {
      const left = pools[i];
      const right = pools[j];

      const leftRes = await getPoolReserves(left);
      const rightRes = await getPoolReserves(right);

      const rebalanceIfNeeded = async (isUsdc: boolean) => {
        const leftAmt = isUsdc ? leftRes.usdc : leftRes.asset;
        const rightAmt = isUsdc ? rightRes.usdc : rightRes.asset;
        if (leftAmt === 0n || rightAmt === 0n) return;

        const lhs = leftAmt * 10000n;
        const rhs = rightAmt * 10500n;
        if (lhs >= rhs) {
          await (await router.connect(aa).rebalance({
            sourcePool: left,
            destPool: right,
            isUsdc,
          })).wait();
          dailyLog.rebalances.push({
            sourcePool: left,
            destPool: right,
            token: isUsdc ? "USDC" : "ASSET",
            amount: ((leftAmt * 250n) / 10000n).toString(),
          });
        }
      };

      await rebalanceIfNeeded(true);
      await rebalanceIfNeeded(false);
    }
  }
}

describe("AA Daily Operations (MCV deposits only)", () => {
  let env: AAEnv;
  let log: DailyLog;

  beforeEach(async () => {
    env = await setupAAEnvironment();
    log = { borrows: [], profitDeposits: [], rebalances: [], completed: false };
  });

  it("borrows, executes cross-DEX profits, deposits, then rebalances", async () => {
    const { deployer, treasuryOps, aa, router, asset, usdc, pools } = env;
    const routerAddr = await router.getAddress();

    for (const poolAddr of pools) {
      const pool = await ethers.getContractAt("FAFEPool", poolAddr);
      const offsetBps = Number(await pool.targetOffsetBps());
      const isNegative = offsetBps < 0;
      const borrowToken = isNegative ? usdc : asset;
      const tokenLabel = isNegative ? "USDC" : "ASSET";

      const reserves = await getPoolReserves(poolAddr);
      const reserve = isNegative ? reserves.usdc : reserves.asset;
      const borrowAmount = reserve / 100n || 1n;

      // Simulate flash loan from TreasuryOps
      await (await borrowToken.connect(deployer).mint(treasuryOps.address, borrowAmount)).wait();
      await (await borrowToken.connect(treasuryOps).transfer(aa.address, borrowAmount)).wait();
      log.borrows.push({
        pool: poolAddr,
        token: tokenLabel,
        amount: borrowAmount.toString(),
      });

      // Cross-DEX search (simulated): AA picks best DEX and earns 50% edge
      const saleProceeds = (borrowAmount * 15000n) / 10000n;
      const profit = saleProceeds - borrowAmount;

      // Repay principal back to TreasuryOps
      await (await borrowToken.connect(aa).transfer(treasuryOps.address, borrowAmount)).wait();

      // Mint profit to AA to simulate external fill
      await (await borrowToken.connect(deployer).mint(aa.address, profit)).wait();

      // Deposit profit back into FAFE pool (AA -> Treasury 5% / pool 95%)
      await approveMax(borrowToken, aa, routerAddr);
      await runDeposit({
        router,
        caller: aa,
        poolAddr,
        isUsdc: isNegative,
        amount: profit,
      });

      const treasuryCut = (profit * 500n) / 10000n;
      const poolAmount = profit - treasuryCut;
      log.profitDeposits.push({
        pool: poolAddr,
        token: tokenLabel,
        amount: profit.toString(),
        treasuryCut: treasuryCut.toString(),
        poolAmount: poolAmount.toString(),
      });
    }

    await runRebalanceScan(env, log);
    log.completed = true;

    expect(log.borrows.length).to.equal(6);
    expect(log.profitDeposits.length).to.equal(6);
    expect(log.completed).to.be.true;
  });
});
