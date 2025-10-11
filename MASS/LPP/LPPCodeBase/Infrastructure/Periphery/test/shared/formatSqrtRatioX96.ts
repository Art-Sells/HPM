// test/shared/formatSqrtRatioX96.ts
import Decimal from "decimal.js";

const TEN = 10n;
const FIVE_SIG_FIGS_POW = new Decimal(10).pow(5);

export function formatSqrtRatioX96(
  sqrtRatioX96: bigint | number,
  decimalsToken0: number = 18,
  decimalsToken1: number = 18
): string {
  Decimal.set({ toExpPos: 9_999_999, toExpNeg: -9_999_999 });

  // normalize bigint → number safely for Decimal math
  const sqrt =
    typeof sqrtRatioX96 === "bigint"
      ? Number(sqrtRatioX96) / 2 ** 96
      : sqrtRatioX96 / 2 ** 96;

  // convert sqrt ratio → price ratio
  const ratio = new Decimal(sqrt).pow(2);

  // adjust for token decimals
  let adjusted = ratio;
  if (decimalsToken1 < decimalsToken0) {
    adjusted = adjusted.mul(new Decimal(10).pow(decimalsToken0 - decimalsToken1));
  } else if (decimalsToken0 < decimalsToken1) {
    adjusted = adjusted.div(new Decimal(10).pow(decimalsToken1 - decimalsToken0));
  }

  // format to five sig figs if small
  if (adjusted.lessThan(FIVE_SIG_FIGS_POW)) {
    return adjusted.toPrecision(5);
  }

  return adjusted.toString();
}