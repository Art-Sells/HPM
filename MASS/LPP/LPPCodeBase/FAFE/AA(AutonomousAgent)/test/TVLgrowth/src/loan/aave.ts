import { ethers } from "ethers";

import { getBaseProvider } from "../onchain/provider";
import { getTokenDecimals } from "../onchain/erc20";
import { LoanQuote } from "../types";

const AAVE_DATA_PROVIDER =
  process.env.AAVE_BASE_DATA_PROVIDER ??
  "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A";
const AAVE_POOL =
  process.env.AAVE_BASE_POOL ?? "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const FLASH_MAX_DURATION_HOURS = Number(
  process.env.AAVE_FLASH_MAX_HOURS ?? (1 / 3600).toFixed(6)
);
const DEFAULT_FLASH_FEE_BPS = Number(
  process.env.AAVE_FLASH_FEE_BPS ?? "9"
);

const RESERVE_TOKENS: Record<
  string,
  { address: string; symbol: string; decimals?: number }
> = {
  WETH: {
    address: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    decimals: 18,
  },
  cbETH: {
    address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
    symbol: "cbETH",
    decimals: 18,
  },
  USDC: {
    address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
    symbol: "USDC",
    decimals: 6,
  },
  USDbC: {
    address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    symbol: "USDC",
    decimals: 6,
  },
  wstETH: {
    address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
    symbol: "wstETH",
    decimals: 18,
  },
};

const DATA_PROVIDER_ABI = [
  "function getReserveData(address asset) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint40)",
];
const POOL_ABI = [
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
];

let cachedFlashFeeBps: number | null = null;

async function getFlashFeeBps(
  provider: ethers.Provider
): Promise<number | null> {
  if (cachedFlashFeeBps !== null) return cachedFlashFeeBps;
  try {
    const pool = new ethers.Contract(AAVE_POOL, POOL_ABI, provider);
    const fee = await pool.FLASHLOAN_PREMIUM_TOTAL();
    cachedFlashFeeBps = Number(fee);
    return cachedFlashFeeBps;
  } catch (err) {
    console.warn("[loan] failed to fetch Aave flash fee, using default", err);
    cachedFlashFeeBps = DEFAULT_FLASH_FEE_BPS;
    return cachedFlashFeeBps;
  }
}

export async function fetchAaveLoanQuotes(
  symbols: string[]
): Promise<LoanQuote[]> {
  const provider = getBaseProvider();
  if (!provider) return [];
  const contract = new ethers.Contract(
    AAVE_DATA_PROVIDER,
    DATA_PROVIDER_ABI,
    provider
  );
  const flashFeeBps = await getFlashFeeBps(provider);

  const tasks = symbols
    .map((symbol) => symbol.toUpperCase())
    .filter((symbol, index, arr) => arr.indexOf(symbol) === index)
    .map(async (symbol) => {
      const meta =
        RESERVE_TOKENS[symbol] ?? RESERVE_TOKENS[symbol.replace(".E", "")];
      if (!meta) return null;
      try {
        const [
          availableLiquidity,
          ,
          ,
          ,
          variableBorrowRate,
          stableBorrowRate,
        ] = await contract.getReserveData(meta.address);
        const decimals =
          meta.decimals ??
          (await getTokenDecimals(meta.address)) ??
          18;
        const available = Number(
          ethers.formatUnits(availableLiquidity, decimals)
        );
        const variableRate =
          Number(variableBorrowRate) / 1_000_000_000_000_000_000_000_000_000;
        const aprBps = Math.round(variableRate * 10_000);

        return {
          lender: "aave-v3-base",
          asset: symbol,
          available,
          aprBps,
          maxDurationHours: FLASH_MAX_DURATION_HOURS,
          flashFeeBps: flashFeeBps ?? undefined,
          timestamp: Date.now(),
        } as LoanQuote;
      } catch (err) {
        console.warn(`[loan] failed to fetch Aave data for ${symbol}`, err);
        return null;
      }
    });

  const results = await Promise.all(tasks);
  return results.filter((entry): entry is LoanQuote => !!entry);
}

