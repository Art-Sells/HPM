import Decimal from "decimal.js";

const FIVE_SIG_FIGS_POW = new Decimal(10).pow(5);

export function formatSqrtRatioX96(
  sqrtRatioX96: bigint | number,
  decimalsToken0: number = 18,
  decimalsToken1: number = 18
): string {
  Decimal.set({ toExpPos: 9_999_999, toExpNeg: -9_999_999 });

  // Convert X96 -> base ratio
  const x96 =
    typeof sqrtRatioX96 === "bigint"
      ? Number(sqrtRatioX96)
      : sqrtRatioX96;

  // === Critical: pre-round to 5 sig figs BEFORE decimal adjustment (matches original test math)
  const baseRatioNum = ((x96 / 2 ** 96) ** 2);
  const fiveSigStr   = Number(baseRatioNum).toPrecision(5); // JS rounding
  let ratio          = new Decimal(fiveSigStr);

  // Adjust for token decimals
  const diff = decimalsToken0 - decimalsToken1;
  if (diff > 0) {
    ratio = ratio.mul(new Decimal(10).pow(diff));
  } else if (diff < 0) {
    ratio = ratio.div(new Decimal(10).pow(-diff));
  }

  // Final output rule
  if (ratio.lessThan(FIVE_SIG_FIGS_POW)) return ratio.toPrecision(5);
  return ratio.toString();
}