#!/usr/bin/env ts-node
import { JsonRpcProvider, Wallet, formatUnits, parseUnits } from "ethers";
import { FlashArbExecutor__factory } from "../../../../typechain-types/factories/TVLGrowth/FlashArbExecutor.sol/FlashArbExecutor__factory";
import { IERC20__factory } from "../../../../typechain-types/factories/external/IERC20__factory";

interface ZeroExQuote {
  to: string;
  data: string;
  value?: string;
  buyAmount: string;
  allowanceTarget?: string;
}

interface SwapCallInput {
  target: string;
  spender: string;
  data: string;
  value: bigint;
  token: string;
}

function env(name: string, required = true): string {
  const value = process.env[name];
  if (required && (!value || value.trim() === "")) {
    throw new Error(`Missing ${name} env var`);
  }
  return value ?? "";
}

async function fetchZeroExQuote(params: {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  taker: string;
  apiKey?: string;
}): Promise<ZeroExQuote> {
  const baseUrl =
    process.env.ZERO_EX_BASE_URL ?? "https://base.api.0x.org";
  const url = new URL("/swap/v1/quote", baseUrl);
  url.searchParams.set("sellToken", params.sellToken);
  url.searchParams.set("buyToken", params.buyToken);
  url.searchParams.set("sellAmount", params.sellAmount);
  url.searchParams.set("takerAddress", params.taker);
  url.searchParams.set("skipValidation", "true");

  const headers: Record<string, string> = {
    "User-Agent": "FAFE-TVLGrowth/1.0",
  };
  if (params.apiKey) {
    headers["0x-api-key"] = params.apiKey;
  }

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `0x quote failed (${res.status} ${res.statusText}): ${text}`
    );
  }
  return (await res.json()) as ZeroExQuote;
}

function parseArg(name: string): string {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) {
    throw new Error(`Missing required arg ${name}`);
  }
  return process.argv[idx + 1];
}

async function main() {
  const executorAddress = parseArg("--executor");
  const borrowToken = parseArg("--borrowToken");
  const intermediateToken = parseArg("--intermediateToken");
  const borrowAmountHuman = parseArg("--borrowAmount");
  const minProfitHuman = parseArg("--minProfit");
  const recipient = process.env.FLASH_PROFIT_RECIPIENT ?? env("PRIVATE_KEY", false);

  const provider = new JsonRpcProvider(env("BASE_INFURA_RPC"));
  const wallet = new Wallet(env("PRIVATE_KEY"), provider);
  const executor = FlashArbExecutor__factory.connect(
    executorAddress,
    wallet
  );

  const borrowTokenContract = IERC20__factory.connect(
    borrowToken,
    provider
  );
  const intermediateTokenContract = IERC20__factory.connect(
    intermediateToken,
    provider
  );

  const borrowTokenDecimals = await borrowTokenContract.decimals();
  const intermediateTokenDecimals = await intermediateTokenContract.decimals();

  const borrowAmount = parseUnits(borrowAmountHuman, borrowTokenDecimals);
  const minProfit = parseUnits(minProfitHuman, borrowTokenDecimals);

  console.log(
    `Preparing flash arb: borrow ${formatUnits(
      borrowAmount,
      borrowTokenDecimals
    )} from ${borrowToken} via executor ${executorAddress}`
  );

  const taker = executorAddress;
  const apiKey = process.env.ZERO_EX_API_KEY;

  const firstQuote = await fetchZeroExQuote({
    sellToken: borrowToken,
    buyToken: intermediateToken,
    sellAmount: borrowAmount.toString(),
    taker,
    apiKey,
  });

  const secondQuote = await fetchZeroExQuote({
    sellToken: intermediateToken,
    buyToken: borrowToken,
    sellAmount: firstQuote.buyAmount,
    taker,
    apiKey,
  });

  const calls: SwapCallInput[] = [
    {
      target: firstQuote.to,
      spender: firstQuote.allowanceTarget ?? firstQuote.to,
      data: firstQuote.data,
      value: BigInt(firstQuote.value ?? "0"),
      token: borrowToken,
    },
    {
      target: secondQuote.to,
      spender: secondQuote.allowanceTarget ?? secondQuote.to,
      data: secondQuote.data,
      value: BigInt(secondQuote.value ?? "0"),
      token: intermediateToken,
    },
  ];

  const tx = await executor.executeFlashArb(borrowToken, borrowAmount, {
    recipient,
    minProfit,
    calls,
  });
  console.log(`Submitted tx ${tx.hash}, waiting...`);
  const receipt = await tx.wait();
  console.log(`Flash arb complete in block ${receipt?.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});



