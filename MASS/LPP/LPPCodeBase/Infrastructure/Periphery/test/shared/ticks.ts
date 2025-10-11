// test/shared/ticks.ts (ethers v6 style)

export const getMinTick = (tickSpacing: number): number =>
  Math.ceil(-887272 / tickSpacing) * tickSpacing

export const getMaxTick = (tickSpacing: number): number =>
  Math.floor(887272 / tickSpacing) * tickSpacing

export const getMaxLiquidityPerTick = (tickSpacing: number): bigint => {
  const numTicks =
    BigInt((getMaxTick(tickSpacing) - getMinTick(tickSpacing)) / tickSpacing + 1)
  const maxUint128 = (1n << 128n) - 1n
  return maxUint128 / numTicks
}