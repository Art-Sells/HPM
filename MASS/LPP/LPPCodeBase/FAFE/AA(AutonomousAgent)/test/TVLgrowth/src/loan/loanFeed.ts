import { LoanQuote } from "../types";
import { fetchAaveLoanQuotes } from "./aave";

export interface LoanFeedOptions {
  dynamicAssets?: string[];
}

export async function loadLoanQuotes(
  options: LoanFeedOptions = {}
): Promise<LoanQuote[]> {
  const shouldFetch =
    (process.env.TVL_WATCHER_FETCH_AAVE ?? "1").toLowerCase() !== "0";
  if (!shouldFetch) {
    console.warn(
      "[loan] TVL_WATCHER_FETCH_AAVE=0; returning empty loan quote set"
    );
    return [];
  }

  try {
    const dynamicQuotes = await fetchAaveLoanQuotes(
      options.dynamicAssets ?? []
    );
    return dynamicQuotes;
  } catch (err) {
    console.warn("[loan] failed to fetch dynamic Aave loans", err);
    return [];
  }
}

