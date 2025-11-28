# AA (Autonomous Agent) Test Suite

This directory contains tests for the Dummy AA API that simulates the Autonomous Agent's daily FAFE operations.

## Overview

The Dummy AA API borrows USDC/cbBTC from TreasuryOps (which acts as a Flash Loan distributor), executes swaps on FAFE pools, simulates external market operations, and deposits profits back to pools.

## Test Structure

Tests in this directory verify:
- Daily FAFE operations cycle through all 6 pools
- Pool operation tracking (swap operations with pool address, direction, amounts, timestamp)
- External sale tracking (deposits back to TreasuryOps)
- Borrow repayment tracking (principal returned to pool)
- Profit deposit tracking (profits deposited to pool)
- Daily completion tracking (all 6 pools completed, operations stop until next day)
- API integration (all operations logged via API endpoints)

## Test Files

- `DailyOperations.spec.ts` - Tests daily cycle through all 6 pools
- `BorrowRepay.spec.ts` - Tests borrowing from TreasuryOps and repayment
- `ProfitDeposit.spec.ts` - Tests profit deposit to pools
- `APIIntegration.spec.ts` - Tests API logging and monitoring

## Running Tests

```bash
npx hardhat test AA\(AutonomousAgent\)/test/
```

