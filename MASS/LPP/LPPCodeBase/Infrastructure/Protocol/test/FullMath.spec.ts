// test/FullMath.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from './shared/expect.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'
import type { FullMathTest } from '../typechain-types/protocol'

// ----- bigint constants (ethers v6 has no BigNumber/constants) -----
const MaxUint256 = (1n << 256n) - 1n
const Q128 = 1n << 128n

describe('FullMath', () => {
  let fullMath: FullMathTest

  async function fixture() {
    const factory = await ethers.getContractFactory('FullMathTest')
    const c = (await factory.deploy()) as unknown as FullMathTest
    await c.waitForDeployment()
    return { fullMath: c }
  }

  before('deploy FullMathTest', async () => {
    ;({ fullMath } = await loadFixture(fixture))
  })

  describe('#mulDiv', () => {
    it('reverts if denominator is 0', async () => {
      await expect(fullMath.mulDiv(Q128, 5n, 0n)).to.be.reverted
    })
    it('reverts if denominator is 0 and numerator overflows', async () => {
      await expect(fullMath.mulDiv(Q128, Q128, 0n)).to.be.reverted
    })
    it('reverts if output overflows uint256', async () => {
      await expect(fullMath.mulDiv(Q128, Q128, 1n)).to.be.reverted
    })
    it('reverts on overflow with all max inputs', async () => {
      await expect(fullMath.mulDiv(MaxUint256, MaxUint256, MaxUint256 - 1n)).to.be.reverted
    })

    it('all max inputs', async () => {
      expect(await fullMath.mulDiv(MaxUint256, MaxUint256, MaxUint256)).to.eq(MaxUint256)
    })

    it('accurate without phantom overflow', async () => {
      const result = Q128 / 3n
      expect(
        await fullMath.mulDiv(
          Q128,
          /* 0.5 */ (50n * Q128) / 100n,
          /* 1.5 */ (150n * Q128) / 100n
        )
      ).to.eq(result)
    })

    it('accurate with phantom overflow', async () => {
      const result = (4375n * Q128) / 1000n
      expect(await fullMath.mulDiv(Q128, 35n * Q128, 8n * Q128)).to.eq(result)
    })

    it('accurate with phantom overflow and repeating decimal', async () => {
      const result = Q128 / 3n
      expect(await fullMath.mulDiv(Q128, 1000n * Q128, 3000n * Q128)).to.eq(result)
    })
  })

  describe('#mulDivRoundingUp', () => {
    it('reverts if denominator is 0', async () => {
      await expect(fullMath.mulDivRoundingUp(Q128, 5n, 0n)).to.be.reverted
    })
    it('reverts if denominator is 0 and numerator overflows', async () => {
      await expect(fullMath.mulDivRoundingUp(Q128, Q128, 0n)).to.be.reverted
    })
    it('reverts if output overflows uint256', async () => {
      await expect(fullMath.mulDivRoundingUp(Q128, Q128, 1n)).to.be.reverted
    })
    it('reverts on overflow with all max inputs', async () => {
      await expect(fullMath.mulDivRoundingUp(MaxUint256, MaxUint256, MaxUint256 - 1n)).to.be.reverted
    })

    // keep these as strings if you like; ABI will parse them as uint256
    it('reverts if mulDiv overflows 256 bits after rounding up', async () => {
      await expect(
        fullMath.mulDivRoundingUp(
          '535006138814359',
          '432862656469423142931042426214547535783388063929571229938474969',
          '2'
        )
      ).to.be.reverted
    })

    it('reverts if mulDiv overflows 256 bits after rounding up case 2', async () => {
      await expect(
        fullMath.mulDivRoundingUp(
          '115792089237316195423570985008687907853269984659341747863450311749907997002549',
          '115792089237316195423570985008687907853269984659341747863450311749907997002550',
          '115792089237316195423570985008687907853269984653042931687443039491902864365164'
        )
      ).to.be.reverted
    })

    it('all max inputs', async () => {
      expect(await fullMath.mulDivRoundingUp(MaxUint256, MaxUint256, MaxUint256)).to.eq(MaxUint256)
    })

    it('accurate without phantom overflow', async () => {
      const result = Q128 / 3n + 1n
      expect(
        await fullMath.mulDivRoundingUp(
          Q128,
          /* 0.5 */ (50n * Q128) / 100n,
          /* 1.5 */ (150n * Q128) / 100n
        )
      ).to.eq(result)
    })

    it('accurate with phantom overflow', async () => {
      const result = (4375n * Q128) / 1000n
      expect(await fullMath.mulDivRoundingUp(Q128, 35n * Q128, 8n * Q128)).to.eq(result)
    })

    it('accurate with phantom overflow and repeating decimal', async () => {
      const result = Q128 / 3n + 1n
      expect(await fullMath.mulDivRoundingUp(Q128, 1000n * Q128, 3000n * Q128)).to.eq(result)
    })
  })

  // ---- Optional fuzzer (still skipped). Converted to bigint so TS compiles. ----
  function randomUint256(): bigint {
    // quick-and-dirty 32-byte random using Math.random (good enough for a skipped test)
    let s = '0x'
    for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
    return BigInt(s)
  }

  it.skip('check a bunch of random inputs against JS bigint implementation', async () => {
    const tests = Array.from({ length: 1000 }, () => ({
      x: randomUint256(),
      y: randomUint256(),
      d: randomUint256(),
    }))

    const floored = (x: bigint, y: bigint, d: bigint) => (x * y) / d
    const ceiled = (x: bigint, y: bigint, d: bigint) => {
      const q = (x * y) / d
      const r = (x * y) % d
      return q + (r > 0n ? 1n : 0n)
    }

    await Promise.all(
      tests.map(async ({ x, y, d }) => {
        const f = fullMath.mulDiv(x, y, d)
        const c = fullMath.mulDivRoundingUp(x, y, d)

        if (d === 0n) {
          await expect(f).to.be.reverted
          await expect(c).to.be.reverted
          return
        }

        // emulate uint256 overflow guard (if desired)
        if (x !== 0n && y !== 0n && x > MaxUint256 / y) {
          await expect(f).to.be.reverted
          await expect(c).to.be.reverted
          return
        }

        expect(await f).to.eq(floored(x, y, d))
        expect(await c).to.eq(ceiled(x, y, d))
      })
    )
  })
})