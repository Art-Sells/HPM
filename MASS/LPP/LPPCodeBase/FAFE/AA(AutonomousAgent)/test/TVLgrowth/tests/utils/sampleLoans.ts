import { LoanQuote } from "../../src/types";

export function createSampleLoanQuotes(): LoanQuote[] {
  const now = Date.now();
  return [
    {
      lender: "stub",
      asset: "USDC",
      available: 1_000_000,
      aprBps: 50,
      maxDurationHours: 1,
      timestamp: now,
    },
    {
      lender: "stub",
      asset: "ASSET",
      available: 100_000,
      aprBps: 75,
      maxDurationHours: 1,
      timestamp: now,
    },
    {
      lender: "stub",
      asset: "cbBTC",
      available: 10_000,
      aprBps: 80,
      maxDurationHours: 1,
      timestamp: now,
    },
  ];
}


