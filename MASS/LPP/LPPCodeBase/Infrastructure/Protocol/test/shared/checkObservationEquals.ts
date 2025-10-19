// test/shared/checkObservationEquals.ts
import type { BigNumberish } from 'ethers'
import { expect } from './expect.ts'

// ethers v6 returns bigint for uints. Normalize both actual & expected to strings for deep equality.
export default function checkObservationEquals(
  actual: {
    tickCumulative: bigint
    secondsPerLiquidityCumulativeX128: bigint
    initialized: boolean
    blockTimestamp: bigint
  },
  expected: {
    tickCumulative: BigNumberish
    secondsPerLiquidityCumulativeX128: BigNumberish
    initialized: boolean
    blockTimestamp: number | bigint
  }
) {
  const toStr = (v: any) => v.toString()

  expect(
    {
      initialized: actual.initialized,
      blockTimestamp: Number(actual.blockTimestamp),
      tickCumulative: toStr(actual.tickCumulative),
      secondsPerLiquidityCumulativeX128: toStr(actual.secondsPerLiquidityCumulativeX128),
    },
    `observation is equivalent`
  ).to.deep.eq({
    initialized: expected.initialized,
    blockTimestamp: Number(expected.blockTimestamp),
    tickCumulative: toStr(expected.tickCumulative),
    secondsPerLiquidityCumulativeX128: toStr(expected.secondsPerLiquidityCumulativeX128),
  })
}