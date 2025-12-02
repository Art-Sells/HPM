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

// Calculate price from tick: price = 1.0001^tick
function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  const price = Math.pow(1.0001, tick);
  // Adjust for decimals: price is token1/token0, we want it in human-readable terms
  return price * (Math.pow(10, decimals0) / Math.pow(10, decimals1));
}

const QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) view returns (uint256 amountOut)",
];

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
];

function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  // sqrtPriceX96 = sqrt(token1/token0) * 2^96 (in raw token units)
  // price = (sqrtPriceX96 / 2^96)^2 = token1/token0 (raw token amounts)
  // Adjust for decimals: actual_price = (token1/token0) * (10^decimals0 / 10^decimals1)
  
  try {
    const Q96 = 79228162514264337593543950336n; // 2^96 precomputed
    
    // Use BigInt arithmetic with scaling to avoid overflow
    // Calculate (sqrtPriceX96^2) / (Q96^2) with proper scaling
    const SCALE = 10n ** 27n; // Large scale factor to maintain precision
    
    // Calculate numerator: sqrtPriceX96^2 * SCALE
    const sqrtPriceSquared = sqrtPriceX96 * sqrtPriceX96;
    const numerator = sqrtPriceSquared * SCALE;
    
    // Calculate denominator: Q96^2
    const q96Squared = Q96 * Q96;
    
    // Divide: (sqrtPriceX96^2 * SCALE) / (Q96^2)
    const scaledResult = numerator / q96Squared;
    
    // Convert to number and divide by scale
    const priceRatio = Number(scaledResult) / Number(SCALE);
    
    if (!isFinite(priceRatio) || priceRatio <= 0 || priceRatio > 1e20) {
      return 0;
    }
    
    // Adjust for decimals: (token1/token0) * (10^decimals0 / 10^decimals1)
    const decAdjust = Math.pow(10, decimals0) / Math.pow(10, decimals1);
    const finalPrice = priceRatio * decAdjust;
    
    return isFinite(finalPrice) && finalPrice > 0 && finalPrice < 1e20 ? finalPrice : 0;
  } catch (err) {
    return 0;
  }
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

// Simple price calculation using quoter contract for accurate quotes
async function getPriceFromQuoter(
  quoter: ethers.Contract,
  tokenIn: string,
  tokenOut: string,
  fee: number,
  amountIn: bigint = ethers.parseUnits("1", 18)
): Promise<number | null> {
  try {
    const amountOut = await quoter.quoteExactInputSingle.staticCall(
      tokenIn,
      tokenOut,
      fee,
      amountIn,
      0n
    );
    // Convert to price: amountOut / amountIn (adjusting for decimals)
    return Number(amountOut) / Number(amountIn);
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
    const tick = Number(slot0.tick);
    if (!sqrtPriceX96 || sqrtPriceX96 === 0n) return null;

    // Determine which token is which
    const baseAddr = pair.baseAddress?.toLowerCase();
    const quoteAddr = pair.quoteAddress?.toLowerCase();
    const token0Lower = token0.toLowerCase();
    const token1Lower = token1.toLowerCase();

    let baseToken: string;
    let quoteToken: string;
    let baseIsToken0: boolean;

    if (baseAddr === token0Lower && quoteAddr === token1Lower) {
      baseToken = token0;
      quoteToken = token1;
      baseIsToken0 = true;
    } else if (baseAddr === token1Lower && quoteAddr === token0Lower) {
      baseToken = token1;
      quoteToken = token0;
      baseIsToken0 = false;
    } else {
      return null; // Pool doesn't match pair
    }

    const baseDecimals = await getTokenDecimals(baseToken);
    const quoteDecimals = await getTokenDecimals(quoteToken);
    if (!baseDecimals || !quoteDecimals) return null;

    // Calculate price from tick (more reliable than sqrtPriceX96 for very small ratios)
    // In Uniswap V3: price = 1.0001^tick, where price = token1/token0
    // tick gives us the price directly without precision issues
    let price: number;
    if (baseIsToken0) {
      // token0 = base, token1 = quote
      // tick price = quote/base
      // We want base/quote, so invert
      const quoteOverBase = tickToPrice(tick, baseDecimals, quoteDecimals);
      price = quoteOverBase > 0 && isFinite(quoteOverBase) ? 1 / quoteOverBase : 0;
    } else {
      // token0 = quote, token1 = base
      // tick price = base/quote
      price = tickToPrice(tick, quoteDecimals, baseDecimals);
    }
    
    if (!isFinite(price) || price <= 0 || price === Infinity || price === 0 || price > 1e20) {
      return null;
    }

    // Estimate liquidity
    let liquidityUsd = 0;
    try {
      const liquidity = await pool.liquidity();
      liquidityUsd = Number(liquidity) / 1e18 * price * 1000;
    } catch (err) {
      liquidityUsd = price * 1000000;
    }

    const reversePrice = price > 0 ? 1 / price : 0;
    if (!isFinite(reversePrice) || reversePrice <= 0) {
      return null;
    }

    const quotes: Quote[] = [
      {
        pairId: `${pair.base}/${pair.quote}`,
        venueId: `uniswap-v3:${poolAddress}`,
        tokenIn: pair.base,
        tokenOut: pair.quote,
        amountIn: 1,
        amountOut: price,
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
        amountOut: reversePrice,
        price: reversePrice,
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

      // Log which pairs we're querying
      console.log(`[uniswap-v3] Querying ${pairs.length} pairs for Uniswap pools`);

      // Query pools in parallel for better performance
      const poolPromises = pairs.map(async (pair) => {
        const baseAddr = pair.baseAddress;
        const quoteAddr = pair.quoteAddress;
        if (!baseAddr || !quoteAddr) {
          return [];
        }

        // Try each fee tier (0.05%, 0.3%, 1%) - try both token orders
        for (const fee of FEE_TIERS) {
          try {
            // Try normal order
            let poolAddress = await findPool(factory, baseAddr, quoteAddr, fee);
            if (poolAddress) {
              const quotes = await fetchPoolData(poolAddress, pair);
              if (quotes && quotes.length > 0) {
                console.log(`[uniswap-v3] Found pool for ${pair.base}/${pair.quote} at ${poolAddress} (fee ${fee})`);
                return quotes;
              }
            }

            // Try reverse order
            poolAddress = await findPool(factory, quoteAddr, baseAddr, fee);
            if (poolAddress) {
              // Create reversed pair for lookup
              const reversedPair = {
                ...pair,
                base: pair.quote,
                quote: pair.base,
                baseAddress: pair.quoteAddress,
                quoteAddress: pair.baseAddress,
              };
              const quotes = await fetchPoolData(poolAddress, reversedPair);
              if (quotes && quotes.length > 0) {
                console.log(`[uniswap-v3] Found pool for ${pair.base}/${pair.quote} (reversed) at ${poolAddress} (fee ${fee})`);
                // Reverse quotes back to original pair orientation
                return quotes.map(q => ({
                  ...q,
                  pairId: `${pair.base}/${pair.quote}`,
                  tokenIn: q.tokenIn === reversedPair.base ? pair.base : pair.quote,
                  tokenOut: q.tokenOut === reversedPair.base ? pair.base : pair.quote,
                  price: q.price === 0 ? 0 : 1 / q.price,
                  amountOut: q.amountIn,
                  amountIn: q.amountOut,
                }));
              }
            }
          } catch (err) {
            // Continue to next fee tier - don't log every failure to avoid spam
            continue;
          }
        }
        // No Uniswap pool found for this pair
        return [];
      });

      const results = await Promise.all(poolPromises);
      for (const quotes of results) {
        if (quotes.length > 0) {
          allQuotes.push(...quotes);
        }
      }

      console.log(`[uniswap-v3] fetched ${allQuotes.length} quotes from ${allQuotes.length > 0 ? new Set(allQuotes.map(q => q.pairId)).size : 0} pairs`);
      return allQuotes;
    },
  };
}

