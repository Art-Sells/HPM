import Decimal from 'decimal.js';

const Q96 = new Decimal(2).pow(96);

export function encodePriceSqrt(
  numerator: number | bigint,
  denominator: number | bigint
): bigint {
  // Supports fractional inputs like 1e-34
  const num = new Decimal(numerator.toString());
  const den = new Decimal(denominator.toString());
  const price = num.div(den);         // P
  const sqrt = price.sqrt();          // sqrt(P)
  const x96  = sqrt.mul(Q96);         // sqrt(P) * 2^96
  return BigInt(x96.floor().toFixed(0));
}