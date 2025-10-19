// test/BitMath.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from './shared/expect.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'
import type { BitMathTest } from '../typechain-types/protocol'

describe('BitMath', () => {
  let bitMath: BitMathTest

  async function fixture() {
    const factory = await ethers.getContractFactory('BitMathTest')
    const c = (await factory.deploy()) as unknown as BitMathTest
    await c.waitForDeployment()
    return { bitMath: c }
  }

  beforeEach('deploy BitMathTest', async () => {
    ;({ bitMath } = await loadFixture(fixture))
  })

  describe('#mostSignificantBit', () => {
    it('0', async () => {
      await expect(bitMath.mostSignificantBit(0)).to.be.reverted
    })
    it('1', async () => {
      expect(await bitMath.mostSignificantBit(1)).to.eq(0n)
    })
    it('2', async () => {
      expect(await bitMath.mostSignificantBit(2)).to.eq(1n)
    })
    it('all powers of 2', async () => {
      const results = await Promise.all(
        Array.from({ length: 255 }, (_, i) => bitMath.mostSignificantBit(1n << BigInt(i)))
      )
      expect(results).to.deep.eq(Array.from({ length: 255 }, (_, i) => BigInt(i)))
    })
    it('uint256(-1)', async () => {
      expect(await bitMath.mostSignificantBit((1n << 256n) - 1n)).to.eq(255n)
    })

    it('gas cost of smaller number', async () => {
      await snapshotGasCost(bitMath.getGasCostOfMostSignificantBit(3568n))
    })
    it('gas cost of max uint128', async () => {
      await snapshotGasCost(bitMath.getGasCostOfMostSignificantBit((1n << 128n) - 1n))
    })
    it('gas cost of max uint256', async () => {
      await snapshotGasCost(bitMath.getGasCostOfMostSignificantBit((1n << 256n) - 1n))
    })
  })

  describe('#leastSignificantBit', () => {
    it('0', async () => {
      await expect(bitMath.leastSignificantBit(0)).to.be.reverted
    })
    it('1', async () => {
      expect(await bitMath.leastSignificantBit(1)).to.eq(0n)
    })
    it('2', async () => {
      expect(await bitMath.leastSignificantBit(2)).to.eq(1n)
    })
    it('all powers of 2', async () => {
      const results = await Promise.all(
        Array.from({ length: 255 }, (_, i) => bitMath.leastSignificantBit(1n << BigInt(i)))
      )
      expect(results).to.deep.eq(Array.from({ length: 255 }, (_, i) => BigInt(i)))
    })
    it('uint256(-1)', async () => {
      expect(await bitMath.leastSignificantBit((1n << 256n) - 1n)).to.eq(0n)
    })

    it('gas cost of smaller number', async () => {
      await snapshotGasCost(bitMath.getGasCostOfLeastSignificantBit(3568n))
    })
    it('gas cost of max uint128', async () => {
      await snapshotGasCost(bitMath.getGasCostOfLeastSignificantBit((1n << 128n) - 1n))
    })
    it('gas cost of max uint256', async () => {
      await snapshotGasCost(bitMath.getGasCostOfLeastSignificantBit((1n << 256n) - 1n))
    })
  })
})