// test/Path.spec.ts
import hre from 'hardhat'
const { ethers } = hre
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'

import { FeeAmount } from './shared/constants.ts'
import { expect } from './shared/expect.ts'
import type { PathTest } from '../typechain-types/periphery'
import { decodePath, encodePath } from './shared/path.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'

describe('Path', () => {
  let path: PathTest

  const tokenAddresses = [
    '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
    '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
    '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
  ] as const

  const fees = [FeeAmount.ZERO, FeeAmount.ZERO] as const

  async function pathTestFixture(): Promise<PathTest> {
    const factory = await ethers.getContractFactory('PathTest')
    const deployed = await factory.deploy()
    await deployed.waitForDeployment()
    return deployed as unknown as PathTest
  }

  beforeEach('deploy PathTest', async () => {
    path = await loadFixture(pathTestFixture)
  })

  it('js encoding works as expected', async () => {
    let expectedPath =
      '0x' +
      tokenAddresses
        .slice(0, 2)
        .map((addr) => addr.slice(2).toLowerCase())
        .join('000bb8') // 0x000bb8 == 3000 decimal

    expect(encodePath(tokenAddresses.slice(0, 2), fees.slice(0, 1))).to.eq(expectedPath)

    expectedPath =
      '0x' + tokenAddresses.map((addr) => addr.slice(2).toLowerCase()).join('000bb8')

    expect(encodePath(tokenAddresses as unknown as string[], fees as unknown as number[])).to.eq(
      expectedPath
    )
  })

  it('js decoding works as expected', async () => {
    const encodedPath = encodePath(tokenAddresses as unknown as string[], fees as unknown as number[])
    const [decodedTokens, decodedFees] = decodePath(encodedPath)
    expect(decodedTokens).to.deep.eq(tokenAddresses)
    expect(decodedFees).to.deep.eq(fees)
  })

  describe('#hasMultiplePools / #decodeFirstPool / #skipToken / #getFirstPool', () => {
    const encodedPath = encodePath(tokenAddresses as unknown as string[], fees as unknown as number[])

    it('works on first pool', async () => {
      expect(await path.hasMultiplePools(encodedPath)).to.be.true

      const firstPool = await path.decodeFirstPool(encodedPath)
      expect(firstPool.tokenA).to.eq(tokenAddresses[0])
      expect(firstPool.tokenB).to.eq(tokenAddresses[1])
      expect(firstPool.fee).to.eq(FeeAmount.ZERO)

      expect(await path.decodeFirstPool(await path.getFirstPool(encodedPath))).to.deep.eq(firstPool)
    })

    // one address (20 bytes) + one fee (3 bytes)
    const offset = 20 + 3

    it('skips 1 item', async () => {
      const skipped = await path.skipToken(encodedPath)
      expect(skipped).to.eq('0x' + encodedPath.slice(2 + offset * 2))

      expect(await path.hasMultiplePools(skipped)).to.be.false

      const { tokenA, tokenB, fee: decodedFee } = await path.decodeFirstPool(skipped)
      expect(tokenA).to.eq(tokenAddresses[1])
      expect(tokenB).to.eq(tokenAddresses[2])
      expect(decodedFee).to.eq(FeeAmount.ZERO)
    })
  })

  it('gas cost', async () => {
    await snapshotGasCost(
      path.getGasCostOfDecodeFirstPool(
        encodePath(
          [tokenAddresses[0], tokenAddresses[1]] as unknown as string[],
          [FeeAmount.ZERO] as unknown as number[]
        )
      )
    )
  })
})