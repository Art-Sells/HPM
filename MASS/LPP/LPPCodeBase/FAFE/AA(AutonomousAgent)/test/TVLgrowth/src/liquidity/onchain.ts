import { ethers } from "ethers";

import { PairRequest } from "../types";
import { getBaseProvider } from "../onchain/provider";
import { getTokenBalance, getTokenDecimals } from "../onchain/erc20";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isValidAddress(address?: string): address is string {
  if (!address) return false;
  const normalized = address.toLowerCase();
  if (normalized === ZERO_ADDRESS) return false;
  try {
    return ethers.isAddress(address);
  } catch {
    return false;
  }
}

export interface OnchainLiquidity {
  baseAmount: number;
  quoteAmount: number;
}

export type OnchainLiquidityMap = Record<string, OnchainLiquidity>;

export async function fetchOnchainLiquidity(
  pairs: PairRequest[]
): Promise<OnchainLiquidityMap> {
  const provider = getBaseProvider();
  if (!provider) return {};
  const useOnchain =
    (process.env.TVL_WATCHER_ONCHAIN ?? "1").toLowerCase() !== "0";
  if (!useOnchain) return {};

  const tasks = pairs.map(async (pair) => {
    if (
      !isValidAddress(pair.pairAddress) ||
      !isValidAddress(pair.baseAddress) ||
      !isValidAddress(pair.quoteAddress)
    ) {
      console.warn(
        `[onchain] skipping ${pair.base}/${pair.quote} (missing addresses)`
      );
      return null;
    }
    const [baseBalance, quoteBalance, baseDecimals, quoteDecimals] =
      await Promise.all([
        getTokenBalance(pair.baseAddress, pair.pairAddress),
        getTokenBalance(pair.quoteAddress, pair.pairAddress),
        getTokenDecimals(pair.baseAddress),
        getTokenDecimals(pair.quoteAddress),
      ]);
    if (
      baseBalance === null ||
      quoteBalance === null ||
      baseDecimals === null ||
      quoteDecimals === null
    ) {
      return null;
    }
    const baseAmount = Number(
      ethers.formatUnits(baseBalance, baseDecimals)
    );
    const quoteAmount = Number(
      ethers.formatUnits(quoteBalance, quoteDecimals)
    );
    return {
      pairId: `${pair.base}/${pair.quote}`,
      liquidity: { baseAmount, quoteAmount },
    };
  });

  const results = await Promise.all(tasks);
  const map: OnchainLiquidityMap = {};
  for (const entry of results) {
    if (!entry) continue;
    map[entry.pairId] = entry.liquidity;
  }
  return map;
}

