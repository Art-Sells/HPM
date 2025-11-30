import { ethers } from "ethers";

import { getBaseProvider } from "../onchain/provider";
import { limitPrecision } from "./utils";

const QUOTER_ADDRESS =
  process.env.UNISWAP_V3_QUOTER ??
  "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const MAX_SEARCH_ITERS = 12;

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];

const QUOTER_ABI = [
  "function quoteExactInput(bytes path, uint256 amountIn) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

export interface TokenQuoteMeta {
  address: string;
  decimals: number;
  priceUsd: number;
}

export interface UniswapDepthParams {
  poolAddress?: string;
  tokenIn: TokenQuoteMeta;
  tokenOut: TokenQuoteMeta;
  slippageBps: number;
  targetTokens: number;
  reserveCapTokens?: number;
}

export async function estimateUniswapMaxInput(
  params: UniswapDepthParams
): Promise<number | null> {
  if (!params.poolAddress) return null;
  const provider = getBaseProvider();
  if (!provider) return null;
  const poolAddress = params.poolAddress;
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const quoter = new ethers.Contract(QUOTER_ADDRESS, QUOTER_ABI, provider);

  let fee: number;
  let token0: string;
  let token1: string;
  try {
    [token0, token1, fee] = await Promise.all([
      pool.token0(),
      pool.token1(),
      pool.fee(),
    ]);
  } catch (err) {
    console.warn("[depth:uniswap] failed to fetch pool metadata", err);
    return null;
  }
  token0 = token0.toLowerCase();
  token1 = token1.toLowerCase();
  const tokenInAddr = params.tokenIn.address.toLowerCase();
  const tokenOutAddr = params.tokenOut.address.toLowerCase();
  if (
    (tokenInAddr !== token0 || tokenOutAddr !== token1) &&
    (tokenInAddr !== token1 || tokenOutAddr !== token0)
  ) {
    return null;
  }

  const path =
    tokenInAddr === token0
      ? ethers.solidityPacked(
          ["address", "uint24", "address"],
          [token0, fee, token1]
        )
      : ethers.solidityPacked(
          ["address", "uint24", "address"],
          [token1, fee, token0]
        );

  const minProbe =
    params.targetTokens > 0
      ? Math.min(
          params.targetTokens * 1e-6,
          Math.pow(10, -Math.min(params.tokenIn.decimals, 6))
        )
      : Math.pow(10, -Math.min(params.tokenIn.decimals, 6));
  const baselineTokens = Math.max(minProbe, 1e-12);
  const baselineOut = await quoteAmount(
    quoter,
    path,
    baselineTokens,
    params.tokenIn.decimals,
    params.tokenOut.decimals
  );
  if (!baselineOut || baselineOut <= 0) {
    return null;
  }

  const basePrice = baselineOut / baselineTokens;
  const allowedImpact = params.slippageBps;
  if (allowedImpact <= 0) {
    return Math.min(
      params.targetTokens,
      params.reserveCapTokens ?? params.targetTokens
    );
  }

  const reserveCap =
    (params.reserveCapTokens ?? params.targetTokens * 4) ||
    params.targetTokens;
  if (reserveCap <= 0) return null;

  let low = 0;
  let high = Math.min(params.targetTokens, reserveCap);
  if (high <= 0) return null;
  let best = 0;

  const impact = await priceImpact(
    quoter,
    path,
    high,
    params.tokenIn.decimals,
    params.tokenOut.decimals,
    basePrice
  );
  if (impact === null) return null;

  if (impact <= allowedImpact) {
    best = high;
    while (best < reserveCap) {
      const candidate = Math.min(best * 2, reserveCap);
      const impactCandidate = await priceImpact(
        quoter,
        path,
        candidate,
        params.tokenIn.decimals,
        params.tokenOut.decimals,
        basePrice
      );
      if (impactCandidate === null) break;
      if (impactCandidate > allowedImpact) {
        high = candidate;
        low = best;
        break;
      }
      best = candidate;
      if (candidate === reserveCap) {
        return candidate;
      }
    }
    if (best === reserveCap) {
      return best;
    }
  } else {
    high = params.targetTokens;
  }

  if (low === 0) {
    low = baselineTokens;
  }

  for (let i = 0; i < MAX_SEARCH_ITERS; i++) {
    const mid = (low + high) / 2;
    const impactMid = await priceImpact(
      quoter,
      path,
      mid,
      params.tokenIn.decimals,
      params.tokenOut.decimals,
      basePrice
    );
    if (impactMid === null) break;
    if (impactMid > allowedImpact) {
      high = mid;
    } else {
      best = mid;
      low = mid;
    }
    if (Math.abs(high - low) / high < 0.02) {
      break;
    }
  }

  return Math.min(best || low, reserveCap);
}

async function quoteAmount(
  quoter: ethers.Contract,
  path: string,
  amountTokens: number,
  decimalsIn: number,
  decimalsOut: number
): Promise<number | null> {
  if (amountTokens <= 0) return null;
  try {
    const amountIn = ethers.parseUnits(
      limitPrecision(amountTokens, decimalsIn),
      decimalsIn
    );
    const [amountOut] = await quoter.quoteExactInput(path, amountIn);
    return Number(ethers.formatUnits(amountOut, decimalsOut));
  } catch (err) {
    console.warn("[depth:uniswap] quoteExactInput failed", err);
    return null;
  }
}

async function priceImpact(
  quoter: ethers.Contract,
  path: string,
  amountTokens: number,
  decimalsIn: number,
  decimalsOut: number,
  basePrice: number
): Promise<number | null> {
  const amountOut = await quoteAmount(
    quoter,
    path,
    amountTokens,
    decimalsIn,
    decimalsOut
  );
  if (!amountOut || amountOut <= 0) return null;
  const avgPrice = amountOut / amountTokens;
  if (avgPrice <= 0 || basePrice <= 0) return null;
  const impact = Math.max(
    0,
    ((basePrice - avgPrice) / basePrice) * 10_000
  );
  return impact;
}


