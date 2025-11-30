import { estimateUniswapMaxInput, TokenQuoteMeta as UniToken } from "./uniswapV3";
import { estimateAerodromeMaxInput, TokenQuoteMeta as AeroToken } from "./aerodrome";
import { getDepthMode, parseVenueId } from "./utils";
import { PairRequest } from "../types";

export interface DepthTokenMeta {
  address: string;
  decimals: number;
  priceUsd: number;
}

export interface DepthContext {
  pair: PairRequest;
  venueId: string;
  direction: "quoteToBase" | "baseToQuote";
  tokenIn: DepthTokenMeta;
  tokenOut: DepthTokenMeta;
  targetTokens: number;
  slippageBps: number;
  reserveCapTokens?: number;
}

export async function capTradeSizeByDepth(
  ctx: DepthContext
): Promise<number | null> {
  if (getDepthMode() === "mock") {
    return null;
  }
  const { dexId, address } = parseVenueId(ctx.venueId);
  if (!address) return null;

  if (dexId.startsWith("uniswap")) {
    return estimateUniswapMaxInput({
      poolAddress: address,
      tokenIn: ctx.tokenIn as UniToken,
      tokenOut: ctx.tokenOut as UniToken,
      slippageBps: ctx.slippageBps,
      targetTokens: ctx.targetTokens,
      reserveCapTokens: ctx.reserveCapTokens,
    });
  }

  if (dexId.startsWith("aerodrome")) {
    return estimateAerodromeMaxInput({
      pairAddress: address,
      tokenIn: ctx.tokenIn as AeroToken,
      tokenOut: ctx.tokenOut as AeroToken,
      slippageBps: ctx.slippageBps,
      targetTokens: ctx.targetTokens,
      reserveCapTokens: ctx.reserveCapTokens,
    });
  }

  return null;
}


