// test/shared/constants.ts

export const MaxUint128 = (2n ** 128n) - 1n

export const MIN_SQRT_RATIO = 4295128739n
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n

export const FeeAmount = {
  ZERO: 0,
} as const

export const TICK_SPACINGS: Record<number, number> = {
  [FeeAmount.ZERO]: 10,
}