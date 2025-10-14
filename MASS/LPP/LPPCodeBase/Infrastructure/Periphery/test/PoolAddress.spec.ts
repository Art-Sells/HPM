// test/PoolAddress.spec.ts
import hre from 'hardhat'
const { ethers } = hre
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'

import { expect } from './shared/expect.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'

import type { PoolAddressTest } from '../typechain-types/periphery'

describe('PoolAddress', () => {
  let poolAddress: PoolAddressTest

  async function fixture() {
    const factory = await ethers.getContractFactory('PoolAddressTest')
    const deployed = await factory.deploy()
    await deployed.waitForDeployment()
    return { poolAddress: deployed as unknown as PoolAddressTest }
  }

  beforeEach(async () => {
    ;({ poolAddress } = await loadFixture(fixture))
  })

  describe('#POOL_INIT_CODE_HASH', () => {
    it('equals the hash baked into PoolAddress.sol', async () => {
      const hash = await poolAddress.POOL_INIT_CODE_HASH()
      // sanity check
      expect(hash).to.match(/^0x[0-9a-fA-F]{64}$/)
      // exact literal from PoolAddress.sol
      expect(hash).to.eq(
        '0x4de2ff1161ce569769358bdde75ab6d732e0281dfe07f002480ea00f537a259d'
      )
    })
  })

  describe('#computeAddress', () => {
    it('all arguments equal zero', async () => {
      await expect(
        poolAddress.computeAddress(
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          0
        )
      ).to.be.reverted
    })

    it('matches example from core repo', async () => {
      expect(
        await poolAddress.computeAddress(
          '0x5FbDB2315678afecb367f032d93F642f64180aa3',
          '0x1000000000000000000000000000000000000000',
          '0x2000000000000000000000000000000000000000',
          250
        )
      ).to.matchSnapshot()
    })

    it('token argument order cannot be in reverse', async () => {
      await expect(
        poolAddress.computeAddress(
          '0x5FbDB2315678afecb367f032d93F642f64180aa3',
          '0x2000000000000000000000000000000000000000',
          '0x1000000000000000000000000000000000000000',
          3000
        )
      ).to.be.reverted
    })

    it('gas cost', async () => {
      await snapshotGasCost(
        poolAddress.getGasCostOfComputeAddress(
          '0x5FbDB2315678afecb367f032d93F642f64180aa3',
          '0x1000000000000000000000000000000000000000',
          '0x2000000000000000000000000000000000000000',
          3000
        )
      )
    })
  })
})