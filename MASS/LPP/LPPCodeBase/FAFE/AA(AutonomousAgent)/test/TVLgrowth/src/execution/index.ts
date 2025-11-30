import { ethers } from "ethers";

import { fetchZeroExQuote, getDefaultGasPriceWei } from "./zeroEx";

const USDC_ADDRESS = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA";
const USDBC_ADDRESS = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA";
const DAI_ADDRESS = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";
const USDT_ADDRESS = "0x04BfA94Bd2b225f43E42d65Ef0D2bF47d36b125F";
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";

const STABLE_SET = new Set(
  [USDC_ADDRESS, USDBC_ADDRESS, DAI_ADDRESS, USDT_ADDRESS].map((addr) =>
    addr.toLowerCase()
  )
);

export interface TradeRequest {
  pairId: string;
  sellToken: string;
  buyToken: string;
  sellTokenDecimals: number;
  buyTokenDecimals: number;
  sellAmountTokens: number;
  reserves?: {
    sellReserve?: number;
    buyReserve?: number;
  };
}

export interface TradeResult {
  amountOutTokens: number;
  gasUsd: number;
  sellAmountTokens: number;
}

let cachedEthPriceUsd: number | null = null;
const tokenPriceCache = new Map<string, number>();

export async function quoteTrade(
  request: TradeRequest
): Promise<TradeResult | null> {
  if (request.sellAmountTokens <= 0) return null;
  const sellAmountFormatted = formatAmount(
    request.sellAmountTokens,
    request.sellTokenDecimals
  );
  const sellAmountUnits = ethers.parseUnits(
    sellAmountFormatted,
    request.sellTokenDecimals
  );
  const quote = await fetchZeroExQuote({
    sellToken: request.sellToken,
    buyToken: request.buyToken,
    sellAmount: sellAmountUnits,
  });
  if (!quote) {
    return null;
  }
  const amountOutTokens = Number(
    ethers.formatUnits(quote.buyAmount, request.buyTokenDecimals)
  );
  const gasPriceWei =
    quote.gasPrice === 0n ? await getDefaultGasPriceWei() : quote.gasPrice;
  const gasCostWei = quote.estimatedGas * gasPriceWei;
  const ethPrice = await getEthPriceUsd();
  const gasCostEth = Number(ethers.formatEther(gasCostWei));
  const gasUsd = gasCostEth * ethPrice;
  return {
    amountOutTokens,
    gasUsd,
    sellAmountTokens: request.sellAmountTokens,
  };
}

export async function getTokenPriceUsd(
  tokenAddress: string,
  decimals: number
): Promise<number | null> {
  const normalized = tokenAddress.toLowerCase();
  if (STABLE_SET.has(normalized)) {
    return 1;
  }
  if (normalized === WETH_ADDRESS.toLowerCase()) {
    return getEthPriceUsd();
  }
  const cached = tokenPriceCache.get(normalized);
  if (cached !== undefined) {
    return cached;
  }
  const oneToken = ethers.parseUnits(
    decimals > 4 ? "1" : "1",
    decimals
  );
  const quote = await fetchZeroExQuote({
    sellToken: tokenAddress,
    buyToken: USDC_ADDRESS,
    sellAmount: oneToken,
  });
  if (!quote) {
    return null;
  }
  const usd = Number(ethers.formatUnits(quote.buyAmount, 6));
  tokenPriceCache.set(normalized, usd);
  return usd;
}

export async function getEthPriceUsd(): Promise<number> {
  if (cachedEthPriceUsd !== null) return cachedEthPriceUsd;
  const oneEth = ethers.parseUnits("1", 18);
  const quote = await fetchZeroExQuote({
    sellToken: WETH_ADDRESS,
    buyToken: USDC_ADDRESS,
    sellAmount: oneEth,
  });
  if (!quote) {
    cachedEthPriceUsd = 0;
    return 0;
  }
  cachedEthPriceUsd = Number(ethers.formatUnits(quote.buyAmount, 6));
  return cachedEthPriceUsd;
}

function formatAmount(amount: number, decimals: number): string {
  const precision = Math.min(decimals, 8);
  return amount.toFixed(precision);
}

export async function convertTokensToUsd(
  tokenAddress: string,
  decimals: number,
  amountTokens: number
): Promise<number | null> {
  if (amountTokens === 0) return 0;
  const price = await getTokenPriceUsd(tokenAddress, decimals);
  if (price === null) {
    return null;
  }
  return amountTokens * price;
}

export function clearExecutionCaches() {
  cachedEthPriceUsd = null;
  tokenPriceCache.clear();
}


