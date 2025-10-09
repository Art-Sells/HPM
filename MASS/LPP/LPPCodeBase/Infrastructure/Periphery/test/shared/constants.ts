// test/shared/constants.ts

export const MaxUint128 = (2n ** 128n) - 1n

export const FeeAmount = {
  ZERO: 0,
} as const

export const TICK_SPACINGS: Record<number, number> = {
  [FeeAmount.ZERO]: 10,
}