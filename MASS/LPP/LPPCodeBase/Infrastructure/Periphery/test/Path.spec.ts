// test/Path.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { FeeAmount } from './shared/constants.ts'
import { expect } from './shared/expect.ts'
import { decodePath, encodePath } from './shared/path.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'

import type { PathTest } from '../typechain-types/periphery'

describe('Path', () => {
  let path: PathTest

  // Use mutable arrays (no `as const`) to satisfy encodePath(string[], number[])
  const tokenAddresses: string[] = [
    '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
    '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
    '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
  ]
  const fees: number[] = [FeeAmount.ZERO, FeeAmount.ZERO]

  // ZERO fee encodes as 3 bytes '000000'
  const feeHex = FeeAmount.ZERO.toString(16).padStart(6, '0') // "000000"

  beforeEach('deploy PathTest', async () => {
    const pathTestFactory = await ethers.getContractFactory('PathTest')
    const deployed = await pathTestFactory.deploy()
    await deployed.waitForDeployment()
    path = deployed as unknown as PathTest
  })

  it('js encoding works as expected', async () => {
    // single hop (2 tokens, 1 fee)
    let expectedPath =
      '0x' +
      tokenAddresses
        .slice(0, 2)
        .map((addr) => addr.slice(2).toLowerCase())
        .join(feeHex)

    expect(encodePath(tokenAddresses.slice(0, 2), fees.slice(0, 1))).to.eq(expectedPath)

    // multi-hop (3 tokens, 2 fees)
    expectedPath =
      '0x' +
      tokenAddresses
        .map((addr) => addr.slice(2).toLowerCase())
        .join(feeHex)

    expect(encodePath(tokenAddresses, fees)).to.eq(expectedPath)
  })

  it('js decoding works as expected', async () => {
    const encodedPath = encodePath(tokenAddresses, fees)
    const [decodedTokens, decodedFees] = decodePath(encodedPath)
    expect(decodedTokens).to.deep.eq(tokenAddresses)
    expect(decodedFees).to.deep.eq(fees)
  })

  describe('#hasMultiplePools / #decodeFirstPool / #skipToken / #getFirstPool', () => {
    const encodedPath = encodePath(
      // spread to be explicit these are mutable arrays
      [...tokenAddresses],
      [...fees],
    )

    it('works on first pool', async () => {
      expect(await path.hasMultiplePools(encodedPath)).to.be.true

      const firstPool = await path.decodeFirstPool(encodedPath)
      expect(firstPool.tokenA).to.eq(tokenAddresses[0])
      expect(firstPool.tokenB).to.eq(tokenAddresses[1])
      expect(firstPool.fee).to.eq(FeeAmount.ZERO)

      expect(await path.decodeFirstPool(await path.getFirstPool(encodedPath))).to.deep.eq(firstPool)
    })

    // address (20 bytes) + fee (3 bytes)
    const offsetBytes = 20 + 3

    it('skips 1 item', async () => {
      const skipped = await path.skipToken(encodedPath)
      expect(skipped).to.eq('0x' + encodedPath.slice(2 + offsetBytes * 2))

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
        encodePath([tokenAddresses[0], tokenAddresses[1]], [FeeAmount.ZERO]),
      ),
    )
  })
})