// test/LiquidityMath.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from './shared/expect.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'
import type { LiquidityMathTest } from '../typechain-types/protocol'

// 2**128 as bigint (used in the overflow test)
const Q128 = 1n << 128n

describe('LiquidityMath', () => {
  let liquidityMath: LiquidityMathTest

  async function fixture() {
    const factory = await ethers.getContractFactory('LiquidityMathTest')
    const c = (await factory.deploy()) as unknown as LiquidityMathTest
    await c.waitForDeployment()
    return { liquidityMath: c }
  }

  beforeEach('deploy LiquidityMathTest', async () => {
    ;({ liquidityMath } = await loadFixture(fixture))
  })

  describe('#addDelta', () => {
    it('1 + 0', async () => {
      expect(await liquidityMath.addDelta(1n, 0n)).to.eq(1n)
    })
    it('1 + -1', async () => {
      expect(await liquidityMath.addDelta(1n, -1n)).to.eq(0n)
    })
    it('1 + 1', async () => {
      expect(await liquidityMath.addDelta(1n, 1n)).to.eq(2n)
    })
    it('2**128-15 + 15 overflows', async () => {
      await expect(liquidityMath.addDelta(Q128 - 15n, 15n)).to.be.revertedWith('LA')
    })
    it('0 + -1 underflows', async () => {
      await expect(liquidityMath.addDelta(0n, -1n)).to.be.revertedWith('LS')
    })
    it('3 + -4 underflows', async () => {
      await expect(liquidityMath.addDelta(3n, -4n)).to.be.revertedWith('LS')
    })
    it('gas add', async () => {
      await snapshotGasCost(liquidityMath.getGasCostOfAddDelta(15n, 4n))
    })
    it('gas sub', async () => {
      await snapshotGasCost(liquidityMath.getGasCostOfAddDelta(15n, -4n))
    })
  })
})