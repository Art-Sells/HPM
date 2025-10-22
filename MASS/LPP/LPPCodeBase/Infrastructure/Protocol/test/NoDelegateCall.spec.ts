// test/NoDelegateCall.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'

import type { NoDelegateCallTest } from '../typechain-types/protocol' // keep your pathing
import { expect } from './shared/expect.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'

describe('NoDelegateCall', () => {
  let wallet: HardhatEthersSigner
  let other: HardhatEthersSigner

  before(async () => {
    ;[wallet, other] = (await ethers.getSigners()) as [HardhatEthersSigner, HardhatEthersSigner]
  })

  const noDelegateCallFixture = async () => {
    // 1) Deploy implementation with a generic factory
    const genericFactory = await ethers.getContractFactory('NoDelegateCallTest', wallet)
    const deployedImpl = await genericFactory.deploy()
    const implAddress = await deployedImpl.getAddress()

    // 2) Deploy minimal proxy that points to the implementation
    const proxyFactory = new ethers.ContractFactory(
      genericFactory.interface,
      '0x' + `3d602d80600a3d3981f3363d3d373d3d3d363d73${implAddress.slice(2)}5af43d82803e903d91602b57fd5bf3`,
      wallet
    )
    const deployedProxy = await proxyFactory.deploy()
    const proxyAddress = await deployedProxy.getAddress()

    // 3) Reattach as a typed instance (no __factory import needed)
    const base = (await ethers.getContractAt(
      'NoDelegateCallTest',
      implAddress,
      wallet
    )) as unknown as NoDelegateCallTest

    const proxy = (await ethers.getContractAt(
      'NoDelegateCallTest',
      proxyAddress,
      wallet
    )) as unknown as NoDelegateCallTest

    return { base, proxy }
  }

  let base: NoDelegateCallTest
  let proxy: NoDelegateCallTest

  beforeEach(async () => {
    ;({ base, proxy } = await loadFixture(noDelegateCallFixture))
  })

  it('runtime overhead', async () => {
    const cannot: bigint = await base.getGasCostOfCannotBeDelegateCalled()
    const can: bigint = await base.getGasCostOfCanBeDelegateCalled()
    await snapshotGasCost(cannot - can) // bigint arithmetic, no .sub
  })

  it('proxy can call the method without the modifier', async () => {
    await proxy.canBeDelegateCalled()
  })

  it('proxy cannot call the method with the modifier', async () => {
    await expect(proxy.cannotBeDelegateCalled()).to.be.reverted
  })

  it('can call the method that calls into a private method with the modifier', async () => {
    await base.callsIntoNoDelegateCallFunction()
  })

  it('proxy cannot call the method that calls a private method with the modifier', async () => {
    await expect(proxy.callsIntoNoDelegateCallFunction()).to.be.reverted
  })
})