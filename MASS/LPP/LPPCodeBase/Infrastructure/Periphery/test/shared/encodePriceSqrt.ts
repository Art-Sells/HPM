
const Q192 = 1n << 192n;

// Integer sqrt via Newton's method (monotonic, floor result)
function sqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('sqrt only works on non-negative integers');
  if (value < 2n) return value;
  // Initial guess: 2^(bitlen/2)
  let x0 = 1n << (BigInt((value.toString(2).length + 1) >> 1));
  let x1 = (x0 + value / x0) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) >> 1n;
  }
  return x0;
}


export function encodePriceSqrt(amount1: number | bigint, amount0: number | bigint): bigint {
  const a1 = BigInt(amount1);
  const a0 = BigInt(amount0);
  if (a0 === 0n) throw new Error('amount0 cannot be zero');
  const ratioX192 = (a1 * Q192) / a0;
  return sqrt(ratioX192);
}