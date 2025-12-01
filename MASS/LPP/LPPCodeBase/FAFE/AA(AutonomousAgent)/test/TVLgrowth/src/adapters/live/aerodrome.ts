import { ethers } from "ethers";

import { getBaseProvider } from "../../onchain/provider";
import { getTokenDecimals } from "../../onchain/erc20";
import { PairRequest, Quote, VenueAdapter } from "../../types";

// Aerodrome Router on Base (used to find pools)
const AERODROME_ROUTER =
  process.env.AERODROME_ROUTER ?? "0xcf77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";

const ROUTER_ABI = [
  "function getAmountOut(uint amountIn, address tokenIn, address tokenOut) view returns (uint amountOut, bool stable)",
];

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function stable() view returns (bool)",
];

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
];

// Known Aerodrome pool addresses (we'll discover dynamically via reserves)
// For now, we'll need to either:
// 1. Use Aerodrome's subgraph/API to find pools
// 2. Use known pool addresses from pairs
// 3. Query all pairs from a factory if available

async function fetchPairData(
  pairAddress: string,
  pair: PairRequest
): Promise<Quote[] | null> {
  const provider = getBaseProvider();
  if (!provider) return null;

  try {
    const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, provider);
    const [token0, token1, reserves] = await Promise.all([
      pairContract.token0(),
      pairContract.token1(),
      pairContract.getReserves(),
    ]);

    const reserve0 = reserves[0];
    const reserve1 = reserves[1];
    if (reserve0 === 0n || reserve1 === 0n) return null;

    const baseAddr = pair.baseAddress?.toLowerCase();
    const quoteAddr = pair.quoteAddress?.toLowerCase();
    const token0Lower = token0.toLowerCase();
    const token1Lower = token1.toLowerCase();

    let baseToken: string;
    let quoteToken: string;
    let baseReserve: bigint;
    let quoteReserve: bigint;

    if (
      baseAddr === token0Lower &&
      quoteAddr === token1Lower
    ) {
      baseToken = token0;
      quoteToken = token1;
      baseReserve = reserve0;
      quoteReserve = reserve1;
    } else if (
      baseAddr === token1Lower &&
      quoteAddr === token0Lower
    ) {
      baseToken = token1;
      quoteToken = token0;
      baseReserve = reserve1;
      quoteReserve = reserve0;
    } else {
      return null; // Pair doesn't match
    }

    const baseDecimals = await getTokenDecimals(baseToken);
    const quoteDecimals = await getTokenDecimals(quoteToken);
    if (!baseDecimals || !quoteDecimals) return null;

    // Calculate price from reserves: price = quoteReserve / baseReserve (adjusted for decimals)
    const baseReserveFormatted = Number(ethers.formatUnits(baseReserve, baseDecimals));
    const quoteReserveFormatted = Number(ethers.formatUnits(quoteReserve, quoteDecimals));
    
    if (baseReserveFormatted === 0) return null;

    const price = quoteReserveFormatted / baseReserveFormatted;
    
    // Estimate liquidity in USD (rough: reserves * price)
    const liquidityUsd = baseReserveFormatted * price * 2; // Both sides

    const quotes: Quote[] = [
      {
        pairId: `${pair.base}/${pair.quote}`,
        venueId: `aerodrome-v2:${pairAddress}`,
        tokenIn: pair.base,
        tokenOut: pair.quote,
        amountIn: 1,
        amountOut: price,
        price,
        gasUsd: 0.05,
        liquidityUsd,
        timestamp: Date.now(),
      },
      {
        pairId: `${pair.base}/${pair.quote}`,
        venueId: `aerodrome-v2:${pairAddress}`,
        tokenIn: pair.quote,
        tokenOut: pair.base,
        amountIn: 1,
        amountOut: 1 / price,
        price: 1 / price,
        gasUsd: 0.05,
        liquidityUsd,
        timestamp: Date.now(),
      },
    ];

    return quotes;
  } catch (err) {
    console.warn(`[aerodrome] failed to fetch pair ${pairAddress}:`, err);
    return null;
  }
}

// Helper to discover Aerodrome pools via known addresses or factory
// For now, we'll use the pairAddress from PairRequest if provided
async function discoverAerodromePool(pair: PairRequest): Promise<string | null> {
  // If pairAddress is provided and looks like an Aerodrome pool, use it
  if (pair.pairAddress && ethers.isAddress(pair.pairAddress)) {
    return pair.pairAddress;
  }
  
  // TODO: Query Aerodrome factory/subgraph to find pools
  // For now, return null and let the caller handle discovery
  return null;
}

export function getAerodromeAdapter(): VenueAdapter {
  return {
    id: "aerodrome-v2",
    async fetchQuotes(pairs: PairRequest[]): Promise<Quote[]> {
      const allQuotes: Quote[] = [];

      for (const pair of pairs) {
        // Try to discover pool address
        const pairAddress = await discoverAerodromePool(pair);
        if (!pairAddress) {
          // Try using pairAddress from request if available
          if (pair.pairAddress && ethers.isAddress(pair.pairAddress)) {
            const quotes = await fetchPairData(pair.pairAddress, pair);
            if (quotes) {
              allQuotes.push(...quotes);
            }
          }
          continue;
        }

        const quotes = await fetchPairData(pairAddress, pair);
        if (quotes) {
          allQuotes.push(...quotes);
        }
      }

      return allQuotes;
    },
  };
}

