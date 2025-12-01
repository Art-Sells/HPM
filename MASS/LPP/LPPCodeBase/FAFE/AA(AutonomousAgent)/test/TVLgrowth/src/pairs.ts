import fs from "node:fs";
import path from "node:path";

import { ethers } from "ethers";

import { PairRequest } from "./types";

const DEXSCREENER_SEARCH_URL =
  "https://api.dexscreener.com/latest/dex/search";
const DEFAULT_DISCOVERY_QUERY =
  process.env.TVL_WATCHER_DISCOVERY_QUERY ?? "BASE";
const DEFAULT_DISCOVERY_LIMIT = Number(
  process.env.TVL_WATCHER_DISCOVERY_LIMIT ?? "10"
);
const DYNAMIC_CACHE_MS = Number(
  process.env.TVL_WATCHER_DISCOVERY_CACHE_MS ?? "60000"
);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USDC_ADDRESS = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA";
const CBETH_ADDRESS = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
const CBBTC_ADDRESS = "0xBe9895146f7AF43049ca1C1AE358B0541Ea49704";

function isValidAddress(address?: string): address is string {
  if (!address) return false;
  if (address.toLowerCase() === ZERO_ADDRESS) return false;
  try {
    return ethers.isAddress(address);
  } catch {
    return false;
  }
}

export const DEFAULT_PAIRS: PairRequest[] = [
  {
    base: "ASSET",
    quote: "USDC",
    baseAddress: CBETH_ADDRESS,
    baseDecimals: 18,
    quoteAddress: USDC_ADDRESS,
    quoteDecimals: 6,
  },
  {
    base: "cbBTC",
    quote: "USDC",
    baseAddress: CBBTC_ADDRESS,
    baseDecimals: 8,
    quoteAddress: USDC_ADDRESS,
    quoteDecimals: 6,
  },
];

let cachedPairsFile: PairRequest[] | null = null;
let cachedDynamic: { pairs: PairRequest[]; timestamp: number } | null = null;

interface DexScreenerPair {
  chainId: string;
  pairAddress: string;
  dexId: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string; name: string };
  liquidity?: { usd?: number };
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[];
}

function loadPairsFromFile(filePath: string): PairRequest[] | null {
  try {
    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);
    const raw = fs.readFileSync(absolute, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (entry) => entry?.base && entry?.quote
    ) as PairRequest[];
  } catch (err) {
    console.warn(`[pairs] failed to load ${filePath}:`, err);
    return null;
  }
}

export function getConfiguredPairs(): PairRequest[] {
  if (cachedPairsFile) return cachedPairsFile;
  const overridePath = process.env.TVL_WATCHER_PAIRS;
  if (overridePath) {
    const pairs = loadPairsFromFile(overridePath);
    if (pairs?.length) {
      cachedPairsFile = pairs;
      console.log(
        `[pairs] loaded ${pairs.length} pair(s) from ${overridePath}`
      );
      return cachedPairsFile;
    }
    console.warn(
      `[pairs] ignoring TVL_WATCHER_PAIRS override (no valid entries)`
    );
  }
  cachedPairsFile = DEFAULT_PAIRS;
  return cachedPairsFile;
}

async function fetchTopBasePairs(
  limit: number,
  query: string = DEFAULT_DISCOVERY_QUERY
): Promise<PairRequest[]> {
  // Query Dexscreener's /dex/tokens endpoint for ALL major tokens on Base
  // This aggregates pairs across all major tokens to find the true top pairs by liquidity
  const MAJOR_BASE_TOKENS = [
    "0x4200000000000000000000000000000000000006", // WETH - most liquid
    USDC_ADDRESS,      // USDC - most liquid stablecoin  
    CBETH_ADDRESS,     // cbETH (ASSET)
    "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI
    "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC (different address?)
    "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", // wstETH
    CBBTC_ADDRESS,     // cbBTC
    "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", // DEGEN
    "0xd1dCEbF50E3144Fe43aFac7575EfCE9e33f97B13", // BRETT
  ];
  
  const TOKENS_URL = "https://api.dexscreener.com/latest/dex/tokens";
  const allPairs: DexScreenerPair[] = [];
  const seenAddresses = new Set<string>();
  
  // Fetch pairs for each major token in parallel
  const fetchPromises = MAJOR_BASE_TOKENS.map(async (tokenAddress) => {
    try {
      const url = `${TOKENS_URL}/${tokenAddress}`;
      const response = await fetch(url, {
        headers: { "User-Agent": "FAFE-TVLGrowth/1.0" },
      });
      if (!response.ok) {
        return [];
      }
      const body = (await response.json()) as DexScreenerResponse;
      return body.pairs ?? [];
    } catch (err) {
      console.warn(`[pairs] error fetching pairs for token ${tokenAddress}:`, err);
      return [];
    }
  });
  
  const allResults = await Promise.all(fetchPromises);
  
  // Deduplicate and filter valid Base pairs
  for (const pairs of allResults) {
    for (const pair of pairs) {
      if (pair.chainId?.toLowerCase() !== "base") continue;
      if (!isValidAddress(pair?.pairAddress)) continue;
      if (!isValidAddress(pair?.baseToken?.address)) continue;
      if (!isValidAddress(pair?.quoteToken?.address)) continue;
      
      const addr = pair.pairAddress.toLowerCase();
      if (!seenAddresses.has(addr)) {
        seenAddresses.add(addr);
        allPairs.push(pair);
      }
    }
  }
  
  // Sort all collected pairs by liquidity (USD) descending and take top N
  const sorted = allPairs.sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
  );
  
  const topPairs = sorted.slice(0, limit).map<PairRequest>((pair) => ({
    base: pair.baseToken.symbol ?? pair.baseToken.name ?? "UNKNOWN",
    quote: pair.quoteToken.symbol ?? pair.quoteToken.name ?? "UNKNOWN",
    baseAddress: pair.baseToken.address,
    quoteAddress: pair.quoteToken.address,
    pairAddress: pair.pairAddress,
    chainId: pair.chainId,
    query: `${pair.baseToken.symbol ?? ""} ${
      pair.quoteToken.symbol ?? ""
    }`.trim(),
  }));
  
  console.log(`[pairs] discovered ${allPairs.length} total Base pairs, selected top ${topPairs.length} by liquidity`);
  if (sorted.length > 0) {
    const topLiquidity = sorted[0]?.liquidity?.usd ?? 0;
    console.log(`[pairs] Top pair: ${topPairs[0].base}/${topPairs[0].quote} ($${topLiquidity.toLocaleString()} USD liquidity)`);
    if (sorted.length >= 3) {
      console.log(`[pairs] Top 3: ${sorted.slice(0, 3).map(p => `${p.baseToken.symbol}/${p.quoteToken.symbol} ($${(p.liquidity?.usd ?? 0).toLocaleString()})`).join(', ')}`);
    }
  }
  return topPairs;
}

export async function discoverDynamicPairs(
  limit: number = DEFAULT_DISCOVERY_LIMIT
): Promise<PairRequest[]> {
  const now = Date.now();
  if (
    cachedDynamic &&
    now - cachedDynamic.timestamp < DYNAMIC_CACHE_MS &&
    cachedDynamic.pairs.length >= limit
  ) {
    return cachedDynamic.pairs.slice(0, limit);
  }
  const pairs = await fetchTopBasePairs(limit);
  if (pairs.length) {
    cachedDynamic = { pairs, timestamp: now };
  }
  return pairs;
}

export async function getActivePairs(
  options: { dynamic?: boolean; limit?: number } = {}
): Promise<PairRequest[]> {
  const envPref =
    (process.env.TVL_WATCHER_DYNAMIC ?? "1").toLowerCase() !== "0";
  const dynamicPref = options.dynamic ?? envPref;
  if (dynamicPref) {
    try {
      const pairs = await discoverDynamicPairs(options.limit);
      if (pairs.length) {
        if (options.limit) {
          return pairs.slice(0, options.limit);
        }
        return pairs;
      }
    } catch (err) {
      console.warn("[pairs] dynamic discovery failed", err);
    }
  }
  return getConfiguredPairs();
}

