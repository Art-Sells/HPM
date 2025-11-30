import { ethers } from "ethers";

import { getBaseProvider } from "../onchain/provider";

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
];

const DEFAULT_FEE_BPS = Number(
  process.env.AERODROME_FEE_BPS ?? "30"
);

export interface TokenQuoteMeta {
  address: string;
  decimals: number;
  priceUsd: number;
}

export interface AerodromeDepthParams {
  pairAddress?: string;
  tokenIn: TokenQuoteMeta;
  tokenOut: TokenQuoteMeta;
  slippageBps: number;
  targetTokens: number;
  reserveCapTokens?: number;
}

export async function estimateAerodromeMaxInput(
  params: AerodromeDepthParams
): Promise<number | null> {
  if (!params.pairAddress) return null;
  const provider = getBaseProvider();
  if (!provider) return null;

  const pair = new ethers.Contract(params.pairAddress, PAIR_ABI, provider);
  let token0: string;
  let token1: string;
  let reserves: [bigint, bigint, number];
  try {
    [token0, token1, reserves] = await Promise.all([
      pair.token0(),
      pair.token1(),
      pair.getReserves(),
    ]);
  } catch (err) {
    console.warn("[depth:aerodrome] failed to fetch reserves", err);
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

  const fee = DEFAULT_FEE_BPS / 10_000;
  const impact = params.slippageBps / 10_000;
  if (impact <= fee) return 0;

  const reserveIn =
    tokenInAddr === token0
      ? Number(ethers.formatUnits(reserves[0], params.tokenIn.decimals))
      : Number(ethers.formatUnits(reserves[1], params.tokenIn.decimals));
  const reserveOut =
    tokenInAddr === token0
      ? Number(ethers.formatUnits(reserves[1], params.tokenOut.decimals))
      : Number(ethers.formatUnits(reserves[0], params.tokenOut.decimals));

  if (reserveIn <= 0 || reserveOut <= 0) return null;

  const numerator = (impact - fee) * reserveIn;
  const denominator = (1 - impact) * (1 - fee);
  if (denominator <= 0) return null;
  let amountIn = numerator / denominator;

  const cap = params.reserveCapTokens ?? reserveIn * 0.8;
  amountIn = Math.min(amountIn, cap, params.targetTokens);
  if (amountIn <= 0) return null;
  return amountIn;
}


