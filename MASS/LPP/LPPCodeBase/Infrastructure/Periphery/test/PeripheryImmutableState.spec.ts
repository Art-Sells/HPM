// test/PeripheryImmutableState.spec.ts
import hre from 'hardhat'
const { ethers } = hre
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from './shared/expect.ts'

import type {
  PeripheryImmutableStateTest,
  IWETH9
} from '../typechain-types/periphery'
import type {
  LPPFactory
} from '../typechain-types/protocol'

import { lppRouterFixture } from './shared/externalFixtures.ts'

describe('PeripheryImmutableState', () => {
  let factory: LPPFactory
  let weth9: IWETH9
  let state: PeripheryImmutableStateTest

  // Hardhat Network Helpers-style fixture
  async function peripheryImmutableStateFixture() {
    const signers = await ethers.getSigners()
    // external fixture already builds core deps; pass v6 provider
    const { weth9, factory } = await lppRouterFixture(signers as any, ethers.provider)

    const stateFactory = await ethers.getContractFactory('PeripheryImmutableStateTest')
    const deployed = await stateFactory.deploy(
      await factory.getAddress(),
      await weth9.getAddress()
    )
    await deployed.waitForDeployment()

    const state = deployed as unknown as PeripheryImmutableStateTest
    return { weth9, factory, state }
  }

  beforeEach('load fixture', async () => {
    ;({ state, weth9, factory } = await loadFixture(peripheryImmutableStateFixture))
  })

  it('bytecode size', async () => {
    const code = await ethers.provider.getCode(await state.getAddress())
    expect((code.length - 2) / 2).to.matchSnapshot()
  })

  describe('#WETH9', () => {
    it('points to WETH9', async () => {
      expect(await state.WETH9()).to.eq(await weth9.getAddress())
    })
  })

  describe('#factory', () => {
    it('points to core factory', async () => {
      expect(await state.factory()).to.eq(await factory.getAddress())
    })
  })
})