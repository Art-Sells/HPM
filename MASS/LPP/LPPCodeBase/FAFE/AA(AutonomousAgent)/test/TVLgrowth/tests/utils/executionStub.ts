import { ExecutionHooks } from "../../src/detectors/mispricing";

export function createExecutionStub(options: {
  multiplier?: number;
  gasUsd?: number;
} = {}): ExecutionHooks {
  const multiplier = options.multiplier ?? 1.05;
  const gasUsd = options.gasUsd ?? 0.05;

  return {
    async quoteTrade({ sellAmountTokens }) {
      const amountOutTokens = sellAmountTokens * multiplier;
      return {
        amountOutTokens,
        gasUsd,
        sellAmountTokens,
      };
    },
    async convertTokensToUsd(_address, _decimals, amountTokens) {
      return amountTokens;
    },
  };
}


