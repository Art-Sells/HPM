import { ethers } from "ethers";

import { getBaseProvider } from "../../onchain/provider";
import { getTokenDecimals } from "../../onchain/erc20";
import { PairRequest, Quote, VenueAdapter } from "../../types";

// Uniswap V3 Factory on Base
const UNISWAP_V3_FACTORY =
  process.env.UNISWAP_V3_FACTORY ?? "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const UNISWAP_V3_QUOTER =
  process.env.UNISWAP_V3_QUOTER ?? "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

// Common fee tiers: 500 (0.05%), 3000 (0.3%), 10000 (1%)
const FEE_TIERS = [500, 3000, 10000];

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
];

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

const QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) view returns (uint256 amountOut)",
];

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
];

function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  // sqrtPriceX96 = sqrt(price) * 2^96
  // price = (sqrtPriceX96 / 2^96)^2
  const Q96 = BigInt(2) ** BigInt(96);
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  const price = sqrtPrice * sqrtPrice;
  
  // Adjust for decimals: price in token1/token0 terms, adjust for decimal difference
  const decimalAdjustment = Math.pow(10, decimals0) / Math.pow(10, decimals1);
  return price * decimalAdjustment;
}

async function findPool(
  factory: ethers.Contract,
  token0: string,
  token1: string,
  fee: number
): Promise<string | null> {
  try {
    const pool = await factory.getPool(token0, token1, fee);
    if (pool && pool !== ethers.ZeroAddress) {
      return pool;
    }
  } catch (err) {
    // Pool doesn't exist
  }
  return null;
}

async function getPoolQuote(
  pool: ethers.Contract,
  quoter: ethers.Contract,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  decimalsIn: number,
  decimalsOut: number
): Promise<{ amountOut: number; gasUsd: number } | null> {
  try {
    const fee = await pool.fee();
    const amountOut = await quoter.quoteExactInputSingle(
      tokenIn,
      tokenOut,
      fee,
      amountIn,
      0n
    );
    return {
      amountOut: Number(ethers.formatUnits(amountOut, decimalsOut)),
      gasUsd: 0.08, // Estimate
    };
  } catch (err) {
    return null;
  }
}

async function fetchPoolData(
  poolAddress: string,
  pair: PairRequest
): Promise<Quote[] | null> {
  const provider = getBaseProvider();
  if (!provider) return null;

  try {
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
    const [token0, token1, slot0] = await Promise.all([
      pool.token0(),
      pool.token1(),
      pool.slot0(),
    ]);

    const sqrtPriceX96 = slot0.sqrtPriceX96;
    if (!sqrtPriceX96 || sqrtPriceX96 === 0n) return null;

    // Determine which token is which
    const baseAddr = pair.baseAddress?.toLowerCase();
    const quoteAddr = pair.quoteAddress?.toLowerCase();
    const token0Lower = token0.toLowerCase();
    const token1Lower = token1.toLowerCase();

    let baseToken: string;
    let quoteToken: string;
    let baseIsToken0: boolean;

    if (
      baseAddr === token0Lower &&
      quoteAddr === token1Lower
    ) {
      baseToken = token0;
      quoteToken = token1;
      baseIsToken0 = true;
    } else if (
      baseAddr === token1Lower &&
      quoteAddr === token0Lower
    ) {
      baseToken = token1;
      quoteToken = token0;
      baseIsToken0 = false;
    } else {
      return null; // Pool doesn't match pair
    }

    const baseDecimals = await getTokenDecimals(baseToken);
    const quoteDecimals = await getTokenDecimals(quoteToken);
    if (!baseDecimals || !quoteDecimals) return null;

    // Calculate price: base/quote ratio
    const price = baseIsToken0
      ? sqrtPriceX96ToPrice(sqrtPriceX96, baseDecimals, quoteDecimals)
      : 1 / sqrtPriceX96ToPrice(sqrtPriceX96, quoteDecimals, baseDecimals);

    // Estimate liquidity in USD from sqrtPriceX96 and liquidity value
    // For V3, we can estimate from sqrtPriceX96: get current tick, estimate reserves
    // Simplified: use price and liquidity value as rough estimate
    let liquidityUsd = 0;
    try {
      const liquidity = await pool.liquidity();
      // Rough estimate: assume liquidity value is proportional to price * liquidity amount
      const liquidityValue = Number(liquidity) / 1e18; // Rough normalization
      liquidityUsd = liquidityValue * price * 1000; // Rough multiplier
    } catch (err) {
      // Fallback: estimate from price
      liquidityUsd = price * 1000000; // Rough estimate
    }

    const amountIn = 1;
    const amountOut = price;

    const quotes: Quote[] = [
      {
        pairId: `${pair.base}/${pair.quote}`,
        venueId: `uniswap-v3:${poolAddress}`,
        tokenIn: pair.base,
        tokenOut: pair.quote,
        amountIn,
        amountOut,
        price,
        gasUsd: 0.08,
        liquidityUsd,
        timestamp: Date.now(),
      },
      {
        pairId: `${pair.base}/${pair.quote}`,
        venueId: `uniswap-v3:${poolAddress}`,
        tokenIn: pair.quote,
        tokenOut: pair.base,
        amountIn: 1,
        amountOut: 1 / price,
        price: 1 / price,
        gasUsd: 0.08,
        liquidityUsd,
        timestamp: Date.now(),
      },
    ];

    return quotes;
  } catch (err) {
    console.warn(`[uniswap-v3] failed to fetch pool ${poolAddress}:`, err);
    return null;
  }
}

export function getUniswapV3Adapter(): VenueAdapter {
  return {
    id: "uniswap-v3",
    async fetchQuotes(pairs: PairRequest[]): Promise<Quote[]> {
      const provider = getBaseProvider();
      if (!provider) {
        console.warn("[uniswap-v3] No Base RPC provider available");
        return [];
      }

      const factory = new ethers.Contract(UNISWAP_V3_FACTORY, FACTORY_ABI, provider);
      const allQuotes: Quote[] = [];

      for (const pair of pairs) {
        const baseAddr = pair.baseAddress;
        const quoteAddr = pair.quoteAddress;
        if (!baseAddr || !quoteAddr) {
          console.warn(`[uniswap-v3] Missing addresses for ${pair.base}/${pair.quote}`);
          continue;
        }

        // Try each fee tier (0.05%, 0.3%, 1%)
        let foundPool = false;
        for (const fee of FEE_TIERS) {
          try {
            const poolAddress = await findPool(factory, baseAddr, quoteAddr, fee);
            if (!poolAddress) continue;

            const quotes = await fetchPoolData(poolAddress, pair);
            if (quotes && quotes.length > 0) {
              allQuotes.push(...quotes);
              foundPool = true;
              break; // Use first pool found
            }
          } catch (err) {
            // Try next fee tier
            continue;
          }
        }
        
        if (!foundPool) {
          // Try reverse order (token1, token0) - Uniswap pools can be in either order
          for (const fee of FEE_TIERS) {
            try {
              const poolAddress = await findPool(factory, quoteAddr, baseAddr, fee);
              if (!poolAddress) continue;

              // Swap base/quote in pair for reverse lookup
              const reversedPair = {
                ...pair,
                base: pair.quote,
                quote: pair.base,
                baseAddress: pair.quoteAddress,
                quoteAddress: pair.baseAddress,
              };
              const quotes = await fetchPoolData(poolAddress, reversedPair);
              if (quotes && quotes.length > 0) {
                // Reverse the quotes back
                const reversedQuotes = quotes.map(q => ({
                  ...q,
                  pairId: `${pair.base}/${pair.quote}`,
                  tokenIn: q.tokenIn === pair.quote ? pair.base : pair.quote,
                  tokenOut: q.tokenOut === pair.quote ? pair.base : pair.quote,
                  price: 1 / q.price,
                  amountOut: q.amountIn,
                  amountIn: q.amountOut,
                }));
                allQuotes.push(...reversedQuotes);
                foundPool = true;
                break;
              }
            } catch (err) {
              continue;
            }
          }
        }
      }

      return allQuotes;
    },
  };
}

