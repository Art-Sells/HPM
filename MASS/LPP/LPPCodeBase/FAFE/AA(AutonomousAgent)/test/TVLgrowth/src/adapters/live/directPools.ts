import { ethers } from "ethers";

import { getBaseProvider } from "../../onchain/provider";
import { getTokenDecimals } from "../../onchain/erc20";
import { PairRequest, Quote, VenueAdapter } from "../../types";

// Known high-liquidity pairs to scan
const KNOWN_PAIRS: PairRequest[] = [
  {
    base: "WETH",
    quote: "USDC",
    baseAddress: "0x4200000000000000000000000000000000000006",
    quoteAddress: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
    baseDecimals: 18,
    quoteDecimals: 6,
  },
  {
    base: "cbETH",
    quote: "USDC",
    baseAddress: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
    quoteAddress: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    baseDecimals: 18,
    quoteDecimals: 6,
  },
  {
    base: "cbBTC",
    quote: "USDC",
    baseAddress: "0xBe9895146f7AF43049ca1C1AE358B0541Ea49704",
    quoteAddress: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    baseDecimals: 8,
    quoteDecimals: 6,
  },
];

// Uniswap V3 Factory on Base
const UNISWAP_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const FEE_TIERS = [500, 3000, 10000]; // 0.05%, 0.3%, 1%

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
];

const UNISWAP_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

const AERODROME_PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];

function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const Q96 = 2n ** 96n;
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  const price = sqrtPrice * sqrtPrice;
  const decimalAdjustment = (10 ** decimals0) / (10 ** decimals1);
  return price * decimalAdjustment;
}

async function fetchUniswapPool(
  factory: ethers.Contract,
  token0: string,
  token1: string
): Promise<string | null> {
  for (const fee of FEE_TIERS) {
    try {
      const pool = await factory.getPool(token0, token1, fee);
      if (pool && pool !== ethers.ZeroAddress) {
        return pool;
      }
    } catch (err) {
      continue;
    }
  }
  return null;
}

async function getUniswapQuote(poolAddress: string, pair: PairRequest): Promise<Quote[] | null> {
  const provider = getBaseProvider();
  if (!provider) return null;

  try {
    const pool = new ethers.Contract(poolAddress, UNISWAP_POOL_ABI, provider);
    const [token0, token1, slot0] = await Promise.all([
      pool.token0(),
      pool.token1(),
      pool.slot0(),
    ]);

    const sqrtPriceX96 = slot0.sqrtPriceX96;
    if (!sqrtPriceX96 || sqrtPriceX96 === 0n) return null;

    const baseAddr = pair.baseAddress?.toLowerCase();
    const quoteAddr = pair.quoteAddress?.toLowerCase();
    const token0Lower = token0.toLowerCase();
    const token1Lower = token1.toLowerCase();

    let baseToken: string;
    let quoteToken: string;
    let baseDecimals: number;
    let quoteDecimals: number;
    let price: number;

    if (baseAddr === token0Lower && quoteAddr === token1Lower) {
      baseToken = token0;
      quoteToken = token1;
      baseDecimals = pair.baseDecimals || 18;
      quoteDecimals = pair.quoteDecimals || 6;
      price = sqrtPriceX96ToPrice(sqrtPriceX96, baseDecimals, quoteDecimals);
    } else if (baseAddr === token1Lower && quoteAddr === token0Lower) {
      baseToken = token1;
      quoteToken = token0;
      baseDecimals = pair.baseDecimals || 18;
      quoteDecimals = pair.quoteDecimals || 6;
      price = 1 / sqrtPriceX96ToPrice(sqrtPriceX96, quoteDecimals, baseDecimals);
    } else {
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
        liquidityUsd: 0, // TODO: calculate from liquidity
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
        liquidityUsd: 0,
        timestamp: Date.now(),
      },
    ];

    return quotes;
  } catch (err) {
    return null;
  }
}

// TODO: Add Aerodrome pool discovery via factory/router
async function getAerodromeQuote(pairAddress: string, pair: PairRequest): Promise<Quote[] | null> {
  const provider = getBaseProvider();
  if (!provider || !pairAddress) return null;

  try {
    const pairContract = new ethers.Contract(pairAddress, AERODROME_PAIR_ABI, provider);
    const [token0, token1, reserves] = await Promise.all([
      pairContract.token0(),
      pairContract.token1(),
      pairContract.getReserves(),
    ]);

    const reserve0 = Number(ethers.formatUnits(reserves[0], pair.baseDecimals || 18));
    const reserve1 = Number(ethers.formatUnits(reserves[1], pair.quoteDecimals || 6));
    
    if (reserve0 === 0 || reserve1 === 0) return null;

    const baseAddr = pair.baseAddress?.toLowerCase();
    const quoteAddr = pair.quoteAddress?.toLowerCase();
    const token0Lower = token0.toLowerCase();
    const token1Lower = token1.toLowerCase();

    let price: number;
    if (baseAddr === token0Lower && quoteAddr === token1Lower) {
      price = reserve1 / reserve0;
    } else if (baseAddr === token1Lower && quoteAddr === token0Lower) {
      price = reserve0 / reserve1;
    } else {
      return null;
    }

    const liquidityUsd = reserve0 * price * 2;

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
    return null;
  }
}

export function getDirectPoolsAdapter(): VenueAdapter {
  return {
    id: "direct-pools",
    async fetchQuotes(pairs: PairRequest[]): Promise<Quote[]> {
      const provider = getBaseProvider();
      if (!provider) return [];

      // Use known pairs + discovered pairs
      const allPairs = [...KNOWN_PAIRS, ...pairs];
      const allQuotes: Quote[] = [];

      const factory = new ethers.Contract(UNISWAP_V3_FACTORY, FACTORY_ABI, provider);

      for (const pair of allPairs) {
        const baseAddr = pair.baseAddress;
        const quoteAddr = pair.quoteAddress;
        if (!baseAddr || !quoteAddr) continue;

        // Query Uniswap pool
        let uniswapPool = await fetchUniswapPool(factory, baseAddr, quoteAddr);
        if (!uniswapPool) {
          uniswapPool = await fetchUniswapPool(factory, quoteAddr, baseAddr);
        }
        if (uniswapPool) {
          const quotes = await getUniswapQuote(uniswapPool, pair);
          if (quotes) {
            allQuotes.push(...quotes);
          }
        }

        // Query Aerodrome pool (if pairAddress is provided)
        if (pair.pairAddress) {
          const aerodromeQuotes = await getAerodromeQuote(pair.pairAddress, pair);
          if (aerodromeQuotes) {
            allQuotes.push(...aerodromeQuotes);
          }
        }
      }

      return allQuotes;
    },
  };
}

