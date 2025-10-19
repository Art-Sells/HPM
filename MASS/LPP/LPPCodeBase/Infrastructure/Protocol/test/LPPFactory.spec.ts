// test/LPPFactory.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'

import type { LPPFactory } from '../typechain-types/protocol'
import { expect } from './shared/expect.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'
import { FeeAmount, getCreate2Address, TICK_SPACINGS } from './shared/utilities.ts'

const TEST_ADDRESSES: [string, string] = [
  '0x1000000000000000000000000000000000000000',
  '0x2000000000000000000000000000000000000000',
]

describe('LPPFactory', () => {
  let wallet: HardhatEthersSigner
  let other: HardhatEthersSigner

  let factory: LPPFactory
  let poolBytecode: string

  async function fixture() {
    const factoryFactory = await ethers.getContractFactory('LPPFactory')
    const deployed = (await factoryFactory.deploy()) as unknown as LPPFactory
    await deployed.waitForDeployment()
    return { factory: deployed }
  }

  before(async () => {
    ;[wallet, other] = (await ethers.getSigners()) as HardhatEthersSigner[]
  })

  before('load pool bytecode', async () => {
    poolBytecode = (await ethers.getContractFactory('LPPPool')).bytecode
  })

  beforeEach('deploy factory', async () => {
    ;({ factory } = await loadFixture(fixture))
  })

  // helper to enable ZERO fee before tests that need it
  async function enableZero() {
    await factory.enableFeeAmount(FeeAmount.ZERO, TICK_SPACINGS[FeeAmount.ZERO])
  }

  it('owner is deployer', async () => {
    expect(await factory.owner()).to.eq(await wallet.getAddress())
  })

  it('factory bytecode size', async () => {
    const code = await ethers.provider.getCode(await factory.getAddress())
    expect((code.length - 2) / 2).to.matchSnapshot()
  })

  it('pool bytecode size', async () => {
    await enableZero()
    await factory.createPool(TEST_ADDRESSES[0], TEST_ADDRESSES[1], FeeAmount.ZERO)
    const poolAddress = getCreate2Address(
      await factory.getAddress(),
      TEST_ADDRESSES,
      FeeAmount.ZERO,
      poolBytecode
    )
    const code = await ethers.provider.getCode(poolAddress)
    expect((code.length - 2) / 2).to.matchSnapshot()
  })

  it('initial enabled fee amounts (ZERO only: not enabled by default)', async () => {
    expect(await factory.feeAmountTickSpacing(FeeAmount.ZERO)).to.eq(0)
  })

  async function createAndCheckPool(
    tokens: [string, string],
    feeAmount: typeof FeeAmount[keyof typeof FeeAmount],
    tickSpacing: number = TICK_SPACINGS[feeAmount]
  ) {
    const factoryAddr = await factory.getAddress()
    const create2Address = getCreate2Address(factoryAddr, tokens, feeAmount, poolBytecode)
    const create = factory.createPool(tokens[0], tokens[1], feeAmount)

    await expect(create)
      .to.emit(factory, 'PoolCreated')
      .withArgs(TEST_ADDRESSES[0], TEST_ADDRESSES[1], feeAmount, tickSpacing, create2Address)

    await expect(factory.createPool(tokens[0], tokens[1], feeAmount)).to.be.reverted
    await expect(factory.createPool(tokens[1], tokens[0], feeAmount)).to.be.reverted
    expect(await factory.getPool(tokens[0], tokens[1], feeAmount), 'getPool in order').to.eq(create2Address)
    expect(await factory.getPool(tokens[1], tokens[0], feeAmount), 'getPool in reverse').to.eq(create2Address)

    const poolContractFactory = await ethers.getContractFactory('LPPPool')
    const pool = poolContractFactory.attach(create2Address)
    expect(await pool.factory(), 'pool factory address').to.eq(factoryAddr)
    expect(await pool.token0(), 'pool token0').to.eq(TEST_ADDRESSES[0])
    expect(await pool.token1(), 'pool token1').to.eq(TEST_ADDRESSES[1])
    expect(await pool.fee(), 'pool fee').to.eq(feeAmount)
    expect(await pool.tickSpacing(), 'pool tick spacing').to.eq(tickSpacing)
  }

  describe('#createPool', () => {
    it('succeeds for zero fee pool', async () => {
      await enableZero()
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.ZERO)
    })

    it('succeeds if tokens are passed in reverse (ZERO)', async () => {
      await enableZero()
      await createAndCheckPool([TEST_ADDRESSES[1], TEST_ADDRESSES[0]], FeeAmount.ZERO)
    })

    it('fails if token a == token b', async () => {
      await expect(factory.createPool(TEST_ADDRESSES[0], TEST_ADDRESSES[0], FeeAmount.ZERO)).to.be.reverted
    })

    it('fails if token a is 0 or token b is 0', async () => {
      await expect(factory.createPool(TEST_ADDRESSES[0], ethers.ZeroAddress, FeeAmount.ZERO)).to.be.reverted
      await expect(factory.createPool(ethers.ZeroAddress, TEST_ADDRESSES[0], FeeAmount.ZERO)).to.be.reverted
      await expect(factory.createPool(ethers.ZeroAddress, ethers.ZeroAddress, FeeAmount.ZERO)).to.be.reverted
    })

    it('fails if fee amount is not enabled', async () => {
      await expect(factory.createPool(TEST_ADDRESSES[0], TEST_ADDRESSES[1], FeeAmount.ZERO)).to.be.reverted
    })

    it('gas', async () => {
      await enableZero()
      await snapshotGasCost(factory.createPool(TEST_ADDRESSES[0], TEST_ADDRESSES[1], FeeAmount.ZERO))
    })
  })

  describe('#setOwner', () => {
    it('fails if caller is not owner', async () => {
      await expect(factory.connect(other).setOwner(await wallet.getAddress())).to.be.reverted
    })

    it('updates owner', async () => {
      await factory.setOwner(await other.getAddress())
      expect(await factory.owner()).to.eq(await other.getAddress())
    })

    it('emits event', async () => {
      await expect(factory.setOwner(await other.getAddress()))
        .to.emit(factory, 'OwnerChanged')
        .withArgs(await wallet.getAddress(), await other.getAddress())
    })

    it('cannot be called by original owner', async () => {
      await factory.setOwner(await other.getAddress())
      await expect(factory.setOwner(await wallet.getAddress())).to.be.reverted
    })
  })

  describe('#enableFeeAmount', () => {
    it('fails if caller is not owner', async () => {
      await expect(factory.connect(other).enableFeeAmount(FeeAmount.ZERO, 2)).to.be.reverted
    })
    it('fails if fee is too great', async () => {
      await expect(factory.enableFeeAmount(1_000_000, 10)).to.be.reverted
    })
    it('fails if tick spacing is too small', async () => {
      await expect(factory.enableFeeAmount(FeeAmount.ZERO, 0)).to.be.reverted
    })
    it('fails if tick spacing is too large', async () => {
      await expect(factory.enableFeeAmount(FeeAmount.ZERO, 16834)).to.be.reverted
    })
    it('fails if already initialized', async () => {
      await factory.enableFeeAmount(FeeAmount.ZERO, 5)
      await expect(factory.enableFeeAmount(FeeAmount.ZERO, 10)).to.be.reverted
    })
    it('sets the fee amount in the mapping', async () => {
      await factory.enableFeeAmount(FeeAmount.ZERO, 5)
      expect(await factory.feeAmountTickSpacing(FeeAmount.ZERO)).to.eq(5)
    })
    it('emits an event', async () => {
      await expect(factory.enableFeeAmount(FeeAmount.ZERO, 5))
        .to.emit(factory, 'FeeAmountEnabled')
        .withArgs(FeeAmount.ZERO, 5)
    })
    it('enables pool creation', async () => {
      await factory.enableFeeAmount(FeeAmount.ZERO, 15)
      await createAndCheckPool([TEST_ADDRESSES[0], TEST_ADDRESSES[1]], FeeAmount.ZERO, 15)
    })
  })
})