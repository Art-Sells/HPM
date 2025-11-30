import { ethers } from "ethers";

import { getBaseProvider } from "../onchain/provider";

const ZERO_EX_BASE_URL =
  process.env.ZERO_EX_BASE_URL ?? "https://base.api.0x.org";
const ZERO_EX_API_KEY = process.env.ZERO_EX_API_KEY;
const ZERO_EX_HEADERS: Record<string, string> = {
  "User-Agent": "FAFE-TVLGrowth/1.0",
};
if (ZERO_EX_API_KEY) {
  ZERO_EX_HEADERS["0x-api-key"] = ZERO_EX_API_KEY;
}

export interface ZeroExQuote {
  buyAmount: bigint;
  sellAmount: bigint;
  estimatedGas: bigint;
  gasPrice: bigint;
  price: number;
}

interface ZeroExErrorResponse {
  code?: number;
  reason?: string;
  validationErrors?: Array<{ field: string; reason: string }>;
}

export async function fetchZeroExQuote(params: {
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
}): Promise<ZeroExQuote | null> {
  const query = new URLSearchParams({
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    sellAmount: params.sellAmount.toString(),
    takerAddress: "0x0000000000000000000000000000000000000001",
    skipValidation: "true",
  });
  const url = `${ZERO_EX_BASE_URL}/swap/v1/quote?${query.toString()}`;
  try {
    const response = await fetch(url, { headers: ZERO_EX_HEADERS });
    if (!response.ok) {
      const body = (await safeJson(response)) as ZeroExErrorResponse | null;
      console.warn(
        `[execution] 0x quote failed ${response.status} ${
          body?.reason ?? ""
        } (${params.sellToken}->${params.buyToken})`
      );
      return null;
    }
    const body = (await response.json()) as any;
    return {
      buyAmount: BigInt(body.buyAmount ?? "0"),
      sellAmount: BigInt(body.sellAmount ?? params.sellAmount.toString()),
      estimatedGas: BigInt(body.estimatedGas ?? body.gas ?? "0"),
      gasPrice: BigInt(body.gasPrice ?? "0"),
      price: Number(body.price ?? 0),
    };
  } catch (err) {
    console.warn(
      `[execution] failed to fetch 0x quote (${params.sellToken}->${params.buyToken})`,
      err
    );
    return null;
  }
}

async function safeJson(response: Response): Promise<any | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function getDefaultGasPriceWei(): Promise<bigint> {
  try {
    const provider = getBaseProvider();
    if (!provider) return 0n;
    const fee = await provider.getFeeData();
    return (
      fee.maxFeePerGas ??
      fee.gasPrice ??
      fee.maxPriorityFeePerGas ??
      0n
    );
  } catch {
    return 0n;
  }
}


