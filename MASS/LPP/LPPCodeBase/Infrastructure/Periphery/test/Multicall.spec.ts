// test/Multicall.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import type { TestMulticall } from '../typechain-types/periphery' 

import { expect } from './shared/expect.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'

describe('Multicall', () => {
  let wallets: SignerWithAddress[]
  let multicall: TestMulticall

  before('get wallets', async () => {
    wallets = (await ethers.getSigners()) as SignerWithAddress[]
  })

  beforeEach('create multicall', async () => {
    const Factory = await ethers.getContractFactory('TestMulticall')
    const deployed = await Factory.deploy()
    await deployed.waitForDeployment()
    // ✅ cast through unknown to satisfy TS (BaseContract -> TestMulticall)
    multicall = deployed as unknown as TestMulticall
  })

  it('revert messages are returned', async () => {
    await expect(
      multicall.multicall([multicall.interface.encodeFunctionData('functionThatRevertsWithError', ['abcdef'])])
    ).to.be.revertedWith('abcdef')
  })

  it('return data is properly encoded', async () => {
  const [data] = await multicall.multicall.staticCall([
    multicall.interface.encodeFunctionData('functionThatReturnsTuple', ['1', '2']),
  ])
    const { tuple: { a, b } } = multicall.interface.decodeFunctionResult('functionThatReturnsTuple', data)
    expect(b).to.eq(1)
    expect(a).to.eq(2)
  })

  describe('context is preserved', () => {
    it('msg.value', async () => {
      await multicall.multicall([multicall.interface.encodeFunctionData('pays')], { value: 3 })
      expect(await multicall.paid()).to.eq(3)
    })

    it('msg.value used twice', async () => {
      await multicall.multicall(
        [multicall.interface.encodeFunctionData('pays'), multicall.interface.encodeFunctionData('pays')],
        { value: 3 }
      )
      expect(await multicall.paid()).to.eq(6)
    })

    it('msg.sender', async () => {
      expect(await multicall.returnSender()).to.eq(wallets[0].address)
    })
  })

  it('gas cost of pay w/o multicall', async () => {
    await snapshotGasCost(multicall.pays({ value: 3 }))
  })

  it('gas cost of pay w/ multicall', async () => {
    await snapshotGasCost(multicall.multicall([multicall.interface.encodeFunctionData('pays')], { value: 3 }))
  })
})