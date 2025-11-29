import fs from "node:fs";
import path from "node:path";

import { LoanQuote } from "../types";

const DEFAULT_LOAN_FILE = path.resolve(
  __dirname,
  "..",
  "..",
  "fixtures",
  "loans",
  "aave-base.json"
);

export interface LoanFeedOptions {
  filePath?: string;
}

export function loadLoanQuotes(
  options: LoanFeedOptions = {}
): LoanQuote[] {
  const file = options.filePath ?? DEFAULT_LOAN_FILE;
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(data)) {
      return data as LoanQuote[];
    }
    return [];
  } catch {
    return [];
  }
}

