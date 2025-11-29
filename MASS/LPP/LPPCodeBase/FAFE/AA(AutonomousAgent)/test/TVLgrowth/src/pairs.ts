import fs from "node:fs";
import path from "node:path";

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

export const DEFAULT_PAIRS: PairRequest[] = [
  { base: "ASSET", quote: "USDC" },
  { base: "cbBTC", quote: "USDC" },
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
  const searchLimit = Math.max(limit * 4, 50);
  const url = `${DEXSCREENER_SEARCH_URL}?q=${encodeURIComponent(
    query
  )}&limit=${searchLimit}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "FAFE-TVLGrowth/1.0" },
  });
  if (!response.ok) {
    throw new Error(`dexscreener discovery failed (${response.status})`);
  }
  const body = (await response.json()) as DexScreenerResponse;
  const pairs = (body.pairs ?? [])
    .filter((pair) => pair.chainId?.toLowerCase() === "base")
    .sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
    )
    .slice(0, limit)
    .map<PairRequest>((pair) => ({
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
  return pairs;
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

