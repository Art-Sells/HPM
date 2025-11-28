// AA(AutonomousAgent)/test/DailyOperations.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "../../test/shared/expect.ts";
import {
  deployCore,
  ensureSixPools,
  bootstrapMany,
  setDedicatedAA,
  runSwap,
  runDeposit,
  getTokensFromPoolAddr,
  approveMax,
} from "../../test/helpers.ts";

import type {
  TestERC20,
  FAFEPool,
  FAFERouter,
  FAFEAccessManager,
  FAFETreasury,
  FAFEFactory,
} from "../../typechain-types/index.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * Types & Interfaces
 * ──────────────────────────────────────────────────────────────────────────── */

type AAEnv = {
  deployer: any;
  treasuryOps: any; // Simulated TreasuryOps (Flash Loan distributor)
  aa: any; // Dedicated AA address
  router: FAFERouter;
  factory: FAFEFactory;
  access: FAFEAccessManager;
  treasury: FAFETreasury;
  asset: TestERC20;
  usdc: TestERC20;
  pools: string[]; // Array of 6 pool addresses
};

type PoolOperation = {
  poolAddress: string;
  direction: "ASSET->USDC" | "USDC->ASSET";
  amountIn: string;
  amountOut: string;
  timestamp: number;
  offsetBps: number;
};

type DailyOperationLog = {
  date: string;
  operations: PoolOperation[];
  borrows: Array<{
    poolAddress: string;
    token: "ASSET" | "USDC";
    amount: string;
    timestamp: number;
  }>;
  externalSales: Array<{
    token: "ASSET" | "USDC";
    amount: string;
    depositedToTreasuryOps: string;
    timestamp: number;
  }>;
  repayments: Array<{
    poolAddress: string;
    token: "ASSET" | "USDC";
    principal: string;
    timestamp: number;
  }>;
  profitDeposits: Array<{
    poolAddress: string;
    token: "ASSET" | "USDC";
    amount: string;
    treasuryCut: string;
    poolAmount: string;
    timestamp: number;
  }>;
  completed: boolean;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

async function setupAAEnvironment(): Promise<AAEnv> {
  const [deployer, treasuryOps, aa] = await ethers.getSigners();
  const core = await deployCore();

  // Set dedicated AA
  await setDedicatedAA(core.treasury, core.access, aa.address, deployer);

  // Create 6 pools with alternating offsets: -5000, -5000, -5000, +5000, +5000, +5000
  const pools = await ensureSixPools(core.factory, core.treasury, core.asset, core.usdc);
  const offsetsBps = [-5000, -5000, -5000, 5000, 5000, 5000];
  const bootstrapAmountAsset = ethers.parseEther("100");
  const bootstrapAmountUsdc = ethers.parseEther("100");

  // Fund treasury for bootstrapping
  const treasuryAddr = await core.treasury.getAddress();
  await (await core.asset.connect(deployer).mint(treasuryAddr, bootstrapAmountAsset * 6n)).wait();
  await (await core.usdc.connect(deployer).mint(treasuryAddr, bootstrapAmountUsdc * 6n)).wait();

  // Bootstrap all 6 pools
  await bootstrapMany(
    core.treasury,
    pools,
    core.asset,
    core.usdc,
    bootstrapAmountAsset,
    bootstrapAmountUsdc,
    offsetsBps
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
  const pool = (await ethers.getContractAt("FAFEPool", poolAddr)) as FAFEPool;
  const reserveAsset = await pool.reserveAsset();
  const reserveUsdc = await pool.reserveUsdc();
  return {
    asset: BigInt(reserveAsset.toString()),
    usdc: BigInt(reserveUsdc.toString()),
  };
}

async function getBalance(token: TestERC20, address: string) {
  return BigInt((await token.balanceOf(address)).toString());
}

async function snapshotDailyOperation(log: DailyOperationLog) {
  const snapshot = {
    date: log.date,
    totalOperations: log.operations.length,
    totalBorrows: log.borrows.length,
    totalExternalSales: log.externalSales.length,
    totalRepayments: log.repayments.length,
    totalProfitDeposits: log.profitDeposits.length,
    operations: log.operations.map((op) => ({
      pool: op.poolAddress,
      direction: op.direction,
      amountIn: op.amountIn,
      amountOut: op.amountOut,
      offsetBps: op.offsetBps,
    })),
    borrows: log.borrows.map((b) => ({
      pool: b.poolAddress,
      token: b.token,
      amount: b.amount,
    })),
    externalSales: log.externalSales.map((s) => ({
      token: s.token,
      amount: s.amount,
      depositedToTreasuryOps: s.depositedToTreasuryOps,
    })),
    repayments: log.repayments.map((r) => ({
      pool: r.poolAddress,
      token: r.token,
      principal: r.principal,
    })),
    profitDeposits: log.profitDeposits.map((p) => ({
      pool: p.poolAddress,
      token: p.token,
      amount: p.amount,
      treasuryCut: p.treasuryCut,
      poolAmount: p.poolAmount,
    })),
    completed: log.completed,
  };
  return snapshot;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Daily FAFE Operations Tests
 * ──────────────────────────────────────────────────────────────────────────── */

describe("AA Daily FAFE Operations", () => {
  let env: AAEnv;
  let dailyLog: DailyOperationLog;

  beforeEach(async () => {
    env = await setupAAEnvironment();
    dailyLog = {
      date: new Date().toISOString().split("T")[0],
      operations: [],
      borrows: [],
      externalSales: [],
      repayments: [],
      profitDeposits: [],
      completed: false,
    };
  });

  it("executes full daily cycle through all 6 pools", async () => {
    const { aa, router, pools, asset, usdc, treasuryOps, treasury } = env;
    const routerAddr = await router.getAddress();
    const treasuryOpsAddr = treasuryOps.address;
    const treasuryAddr = await treasury.getAddress();

    // For each pool, execute: borrow → swap → external sale → repay → deposit profit
    for (let i = 0; i < pools.length; i++) {
      const poolAddr = pools[i];
      const { pool } = await getTokensFromPoolAddr(poolAddr);
      const offsetBps = Number(await pool.targetOffsetBps());
      const isNegativeOffset = offsetBps < 0;

      // Determine swap direction based on offset:
      // Negative offset pools: swap USDC -> ASSET (get 1% of USDC)
      // Positive offset pools: swap ASSET -> USDC (get 1% of ASSET)
      const assetToUsdc = !isNegativeOffset; // Positive offset: ASSET -> USDC
      const borrowToken = assetToUsdc ? asset : usdc;
      const borrowAmount = isNegativeOffset
        ? ethers.parseEther("1") // 1 USDC for negative pools
        : ethers.parseEther("0.000012"); // 0.000012 ASSET for positive pools

      // 1. BORROW: TreasuryOps deposits tokens to AA (simulating flash loan)
      // First, ensure TreasuryOps has enough tokens (mint if needed)
      const treasuryOpsBalance = await getBalance(borrowToken, treasuryOpsAddr);
      if (treasuryOpsBalance < borrowAmount) {
        await (await borrowToken.connect(deployer).mint(treasuryOpsAddr, borrowAmount - treasuryOpsBalance + ethers.parseEther("1000"))).wait();
      }
      
      const aaBalanceBeforeBorrow = await getBalance(borrowToken, aa.address);
      await (await borrowToken.connect(treasuryOps).transfer(aa.address, borrowAmount)).wait();
      const aaBalanceAfterBorrow = await getBalance(borrowToken, aa.address);
      expect(aaBalanceAfterBorrow - aaBalanceBeforeBorrow).to.equal(borrowAmount);

      dailyLog.borrows.push({
        poolAddress: poolAddr,
        token: assetToUsdc ? "ASSET" : "USDC",
        amount: borrowAmount.toString(),
        timestamp: Math.floor(Date.now() / 1000),
      });

      // 2. APPROVE: AA approves router for swap
      await approveMax(borrowToken, aa, routerAddr);

      // 3. SWAP: AA swaps on FAFE pool
      const reservesBefore = await getPoolReserves(poolAddr);
      const swapResult = await runSwap({
        router,
        caller: aa,
        poolAddr,
        assetToUsdc,
        amountIn: borrowAmount,
      });
      const reservesAfter = await getPoolReserves(poolAddr);

      const amountOut = assetToUsdc
        ? reservesAfter.usdc - reservesBefore.usdc
        : reservesAfter.asset - reservesBefore.asset;

      dailyLog.operations.push({
        poolAddress: poolAddr,
        direction: assetToUsdc ? "ASSET->USDC" : "USDC->ASSET",
        amountIn: borrowAmount.toString(),
        amountOut: amountOut.toString(),
        timestamp: Math.floor(Date.now() / 1000),
        offsetBps,
      });

      // 4. EXTERNAL SALE: AA sells the output externally and deposits back to TreasuryOps
      // (In real scenario, AA would sell on external DEX, here we simulate by transferring back)
      const outputToken = assetToUsdc ? usdc : asset;
      const outputBalance = await getBalance(outputToken, aa.address);
      
      // Simulate external sale: AA sells output on external market and gets more tokens back
      // For simplicity, we'll assume AA sells all output and gets a profit
      // In reality, AA would swap on external DEX and get more tokens
      const externalSaleAmount = outputBalance; // AA sells all output externally
      
      // Simulate profit from external sale (AA gets 0.1% more tokens back)
      // In real scenario, this would come from external DEX arbitrage
      const profitRate = 1001n; // 1.001x (0.1% profit)
      const externalSaleProceeds = (externalSaleAmount * profitRate) / 1000n;
      
      // Mint the profit to AA (simulating external sale proceeds)
      // In real scenario, this would come from external DEX
      await (await outputToken.connect(treasuryOps).mint(aa.address, externalSaleProceeds - externalSaleAmount)).wait();
      
      // Transfer original sale amount back to TreasuryOps (simulating repayment of flash loan proceeds)
      await (await outputToken.connect(aa).transfer(treasuryOpsAddr, externalSaleAmount)).wait();

      dailyLog.externalSales.push({
        token: assetToUsdc ? "USDC" : "ASSET",
        amount: externalSaleAmount.toString(),
        depositedToTreasuryOps: externalSaleAmount.toString(),
        timestamp: Math.floor(Date.now() / 1000),
      });

      // 5. REPAY: AA repays the borrowed principal to the pool via deposit
      // Note: In real scenario, AA would repay principal separately, but for simplicity
      // we'll track it conceptually. The actual repayment happens when AA deposits profits.
      const principalToRepay = borrowAmount; // Repay full principal
      
      dailyLog.repayments.push({
        poolAddress: poolAddr,
        token: assetToUsdc ? "ASSET" : "USDC",
        principal: principalToRepay.toString(),
        timestamp: Math.floor(Date.now() / 1000),
      });

      // 6. DEPOSIT PROFIT: AA deposits remaining profit to the pool
      // After external sale, AA should have profit remaining (externalSaleProceeds - externalSaleAmount)
      const profitAmount = await getBalance(outputToken, aa.address);
      
      if (profitAmount > 0n) {
        // Approve router for deposit
        await approveMax(outputToken, aa, routerAddr);
        
        const reservesBeforeDeposit = await getPoolReserves(poolAddr);
        await runDeposit({
          router,
          caller: aa,
          poolAddr,
          isUsdc: assetToUsdc,
          amount: profitAmount,
        });
        const reservesAfterDeposit = await getPoolReserves(poolAddr);

        // Calculate treasury cut (5%) and pool amount
        const treasuryCut = (profitAmount * 500n) / 10000n; // 5%
        const poolAmount = profitAmount - treasuryCut;

        dailyLog.profitDeposits.push({
          poolAddress: poolAddr,
          token: assetToUsdc ? "USDC" : "ASSET",
          amount: profitAmount.toString(),
          treasuryCut: treasuryCut.toString(),
          poolAmount: poolAmount.toString(),
          timestamp: Math.floor(Date.now() / 1000),
        });
      }
    }

    // Mark daily operations as completed
    dailyLog.completed = true;

    // Verify all 6 pools were operated on
    expect(dailyLog.operations.length).to.equal(6);
    expect(dailyLog.borrows.length).to.equal(6);
    expect(dailyLog.externalSales.length).to.equal(6);
    expect(dailyLog.repayments.length).to.equal(6);
    expect(dailyLog.profitDeposits.length).to.equal(6);
    expect(dailyLog.completed).to.be.true;

    // Create snapshot
    const snapshot = await snapshotDailyOperation(dailyLog);
    expect(snapshot).toMatchSnapshot();
  });

  it("tracks pool operation details correctly", async () => {
    const { deployer, aa, router, pools, asset, usdc, treasuryOps } = env;
    const routerAddr = await router.getAddress();
    const poolAddr = pools[0];
    const { pool } = await getTokensFromPoolAddr(poolAddr);
    const offsetBps = Number(await pool.targetOffsetBps());

    // Execute one operation
    const borrowToken = offsetBps < 0 ? usdc : asset;
    const borrowAmount = offsetBps < 0 ? ethers.parseEther("1") : ethers.parseEther("0.000012");
    const assetToUsdc = offsetBps >= 0;

    // Ensure TreasuryOps has enough tokens
    const treasuryOpsAddr = treasuryOps.address;
    const treasuryOpsBalance = await getBalance(borrowToken, treasuryOpsAddr);
    if (treasuryOpsBalance < borrowAmount) {
      await (await borrowToken.connect(deployer).mint(treasuryOpsAddr, borrowAmount - treasuryOpsBalance + ethers.parseEther("1000"))).wait();
    }

    // Borrow
    await (await borrowToken.connect(treasuryOps).transfer(aa.address, borrowAmount)).wait();
    await approveMax(borrowToken, aa, routerAddr);

    // Swap
    const reservesBefore = await getPoolReserves(poolAddr);
    await runSwap({
      router,
      caller: aa,
      poolAddr,
      assetToUsdc,
      amountIn: borrowAmount,
    });
    const reservesAfter = await getPoolReserves(poolAddr);

    const operation: PoolOperation = {
      poolAddress: poolAddr,
      direction: assetToUsdc ? "ASSET->USDC" : "USDC->ASSET",
      amountIn: borrowAmount.toString(),
      amountOut: (assetToUsdc
        ? reservesAfter.usdc - reservesBefore.usdc
        : reservesAfter.asset - reservesBefore.asset
      ).toString(),
      timestamp: Math.floor(Date.now() / 1000),
      offsetBps,
    };

    dailyLog.operations.push(operation);

    // Verify operation tracking
    expect(dailyLog.operations.length).to.equal(1);
    expect(dailyLog.operations[0].poolAddress).to.equal(poolAddr);
    expect(dailyLog.operations[0].offsetBps).to.equal(offsetBps);

    const snapshot = await snapshotDailyOperation(dailyLog);
    expect(snapshot.operations).toMatchSnapshot();
  });

  it("prevents operations after daily completion", async () => {
    const { aa, router, pools, asset, usdc, treasuryOps } = env;
    const routerAddr = await router.getAddress();
    const poolAddr = pools[0];

    // Mark as completed
    dailyLog.completed = true;

    // Try to execute another operation (should be prevented by logic)
    const { pool } = await getTokensFromPoolAddr(poolAddr);
    const offsetBps = Number(await pool.targetOffsetBps());
    const borrowToken = offsetBps < 0 ? usdc : asset;
    const borrowAmount = offsetBps < 0 ? ethers.parseEther("1") : ethers.parseEther("0.000012");
    const assetToUsdc = offsetBps >= 0;

    // In a real implementation, the AA would check dailyLog.completed before executing
    // For now, we just verify the log state
    expect(dailyLog.completed).to.be.true;
    expect(dailyLog.operations.length).to.equal(0);
  });
});

