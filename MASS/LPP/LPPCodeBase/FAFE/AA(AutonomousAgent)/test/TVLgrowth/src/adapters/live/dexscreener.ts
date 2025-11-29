import { Agent } from "undici";

import { PairRequest, Quote, VenueAdapter } from "../../types";

const SEARCH_URL = "https://api.dexscreener.com/latest/dex/search";
const PAIRS_URL = "https://api.dexscreener.com/latest/dex/pairs";
const USD_SYMBOLS = new Set([
  "USDC",
  "USDBC",
  "USDT",
  "DAI",
  "AXLUSDC",
  "USD+",
  "USD",
]);
const TOKEN_ALIAS: Record<string, string> = {
  ASSET: "cbETH",
  cbBTC: "cbBTC",
  USDC: "USDC",
  cbETH: "cbETH",
  AERO: "AERO",
  PEPE: "PEPE",
};
const FALLBACK_GAS_USD = 0.08;
const DEFAULT_CHAIN = "base";

const insecureAgent =
  process.env.TVL_WATCHER_ALLOW_INSECURE === "1"
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined;

type Orientation = 1 | -1;

interface DexToken {
  address: string;
  name: string;
  symbol: string;
}

interface DexLiquidity {
  usd?: number;
  base?: number;
  quote?: number;
}

interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: DexToken;
  quoteToken: DexToken;
  priceNative?: string;
  priceUsd?: string;
  liquidity?: DexLiquidity;
}

interface DexResponse {
  pairs: DexPair[];
}

interface PairMatch {
  pair?: DexPair;
  orientation: Orientation;
}

function aliasSymbol(symbol: string): string {
  return TOKEN_ALIAS[symbol] ?? symbol;
}

function normalizeSymbol(symbol: string): string {
  return aliasSymbol(symbol).toLowerCase();
}

function isUsdSymbol(symbol: string): boolean {
  return USD_SYMBOLS.has(symbol.toUpperCase());
}

function tokenMatches(
  token: DexToken,
  desiredSymbol: string,
  desiredAddress?: string
): boolean {
  const symbolMatch =
    token.symbol?.toLowerCase() === normalizeSymbol(desiredSymbol);
  if (desiredAddress) {
    return token.address?.toLowerCase() === desiredAddress.toLowerCase();
  }
  return symbolMatch;
}

function matchPairs(
  pairs: DexPair[],
  req: PairRequest,
  limit = 4
): PairMatch[] {
  const desiredBaseSymbol = req.base;
  const desiredQuoteSymbol = req.quote;
  const matches: PairMatch[] = [];
  const chainFilter = (req.chainId ?? DEFAULT_CHAIN).toLowerCase();
  const sorted = pairs
    .filter((p) => p.chainId?.toLowerCase() === chainFilter)
    .sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
    );

  for (const candidate of sorted) {
    if (matches.length >= limit) {
      break;
    }
    const baseSymbol = candidate.baseToken.symbol.toLowerCase();
    const quoteSymbol = candidate.quoteToken.symbol.toLowerCase();
    const baseAddress = req.baseAddress?.toLowerCase();
    const quoteAddress = req.quoteAddress?.toLowerCase();

    const baseMatches = tokenMatches(
      candidate.baseToken,
      desiredBaseSymbol,
      baseAddress
    );
    const quoteMatches = tokenMatches(
      candidate.quoteToken,
      desiredQuoteSymbol,
      quoteAddress
    );
    const reverseBaseMatches = tokenMatches(
      candidate.baseToken,
      desiredQuoteSymbol,
      quoteAddress
    );
    const reverseQuoteMatches = tokenMatches(
      candidate.quoteToken,
      desiredBaseSymbol,
      baseAddress
    );

    if (baseMatches && quoteMatches) {
      matches.push({ pair: candidate, orientation: 1 });
    } else if (reverseBaseMatches && reverseQuoteMatches) {
      matches.push({ pair: candidate, orientation: -1 });
    }
  }
  return matches;
}

function pickPair(pairs: DexPair[], req: PairRequest): PairMatch {
  const desiredBase = normalizeSymbol(req.base);
  const desiredQuote = normalizeSymbol(req.quote);
  const matches = matchPairs(pairs, req, 1);
  if (matches.length > 0) {
    return matches[0];
  }
  return { orientation: 1 };
}

function toNumber(value?: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function computePriceRatio(pair: DexPair): number | null {
  const priceUsd = toNumber(pair.priceUsd);
  if (priceUsd) {
    if (isUsdSymbol(pair.quoteToken.symbol)) {
      return priceUsd;
    }
    if (isUsdSymbol(pair.baseToken.symbol) && priceUsd !== 0) {
      return 1 / priceUsd;
    }
  }

  const baseLiquidity = pair.liquidity?.base ?? 0;
  const quoteLiquidity = pair.liquidity?.quote ?? 0;
  if (baseLiquidity > 0 && quoteLiquidity > 0) {
    return quoteLiquidity / baseLiquidity;
  }

  const priceNative = toNumber(pair.priceNative);
  if (priceNative) {
    return priceNative;
  }

  return null;
}

export function buildQuoteFromPair(
  req: PairRequest,
  pair: DexPair,
  orientation: Orientation
): Quote | null {
  const ratio = computePriceRatio(pair);
  if (!ratio || ratio <= 0) {
    return null;
  }
  const price = orientation === 1 ? ratio : 1 / ratio;
  const amountIn = 1;
  const amountOut = price;
  return {
    pairId: `${req.base}/${req.quote}`,
    venueId: pair.dexId ?? "dexscreener",
    tokenIn: req.base,
    tokenOut: req.quote,
    amountIn,
    amountOut,
    price,
    gasUsd: FALLBACK_GAS_USD,
    liquidityUsd: pair.liquidity?.usd ?? 0,
    timestamp: Date.now(),
  };
}

async function fetchDexPairs(query: string): Promise<DexPair[]> {
  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "FAFE-TVLGrowth/1.0" },
    ...(insecureAgent ? { dispatcher: insecureAgent } : {}),
  });
  if (!response.ok) {
    throw new Error(`dexscreener request failed (${response.status})`);
  }
  const body = (await response.json()) as DexResponse;
  return body.pairs ?? [];
}

async function fetchPairByAddress(
  chainId: string,
  pairAddress: string
): Promise<DexPair | null> {
  const url = `${PAIRS_URL}/${chainId}/${pairAddress}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "FAFE-TVLGrowth/1.0" },
    ...(insecureAgent ? { dispatcher: insecureAgent } : {}),
  });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as DexResponse;
  return body.pairs?.[0] ?? null;
}

function buildQueries(req: PairRequest): string[] {
  const queries = new Set<string>();
  if (req.query) queries.add(req.query);
  const baseAlias = aliasSymbol(req.base);
  const quoteAlias = aliasSymbol(req.quote);
  queries.add(`${baseAlias} ${quoteAlias}`);
  queries.add(`${req.base} ${req.quote}`);
  queries.add(`${quoteAlias} ${baseAlias}`);
  queries.add(`${req.quote} ${req.base}`);
  queries.add(baseAlias);
  queries.add(req.base);
  queries.add(quoteAlias);
  queries.add(req.quote);
  return Array.from(queries).filter(Boolean);
}

async function resolveMatches(req: PairRequest): Promise<PairMatch[]> {
  const chain = req.chainId ?? DEFAULT_CHAIN;
  if (req.pairAddress) {
    const direct = await fetchPairByAddress(chain, req.pairAddress);
    if (direct) {
      const directMatches = matchPairs([direct], req);
      if (directMatches.length) {
        return directMatches;
      }
    }
  }

  const seen = new Set<string>();
  const matches: PairMatch[] = [];
  for (const query of buildQueries(req)) {
    try {
      const dexPairs = await fetchDexPairs(query);
      const localMatches = matchPairs(dexPairs, req);
      for (const match of localMatches) {
        if (!match.pair) continue;
        const key = `${match.pair.pairAddress}:${match.orientation}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(match);
      }
    } catch (err) {
      console.warn(`[dexscreener] query failed (${query})`, err);
    }
  }
  return matches;
}

export function getDexscreenerAdapter(): VenueAdapter {
  return {
    id: "dexscreener",
    async fetchQuotes(pairs: PairRequest[]): Promise<Quote[]> {
      const quotes: Quote[] = [];
      for (const req of pairs) {
        try {
          const matches = await resolveMatches(req);
          if (!matches.length) {
            console.warn(
              `[dexscreener] no pair for ${req.base}/${req.quote}`
            );
            continue;
          }
          for (const match of matches) {
            const quote = buildQuoteFromPair(req, match.pair!, match.orientation);
            if (!quote) {
              console.warn(
                `[dexscreener] missing price data for ${req.base}/${req.quote}`
              );
              continue;
            }

            const venueLabel = `${match.pair!.dexId}:${match.pair!.pairAddress}`;
            quote.venueId = venueLabel;
            quotes.push(quote);

            if (quote.price > 0) {
              quotes.push({
                ...quote,
                tokenIn: req.quote,
                tokenOut: req.base,
                amountOut: 1 / quote.price,
                price: 1 / quote.price,
                amountIn: 1,
              });
            }
          }
        } catch (err) {
          console.warn(
            `[dexscreener] failed to fetch ${req.base}/${req.quote}`,
            err
          );
        }
      }
      return quotes;
    },
  };
}

export { aliasSymbol, pickPair, matchPairs };

