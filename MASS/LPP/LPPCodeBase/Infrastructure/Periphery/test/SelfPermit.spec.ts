// test/SelfPermit.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { MaxUint256 } from 'ethers'
import type { Signer } from 'ethers'

import type { SelfPermitTest, TestERC20PermitAllowed } from '../typechain-types/periphery'
import { getPermitSignature, getPermitAllowedSignature } from './shared/permit.ts'

describe('SelfPermit', () => {
  let wallet: Signer
  let other: Signer

  async function fixture() {
    const signers = await ethers.getSigners()
    ;[wallet, other] = signers

    const tokenFactory = await ethers.getContractFactory('TestERC20PermitAllowed')
    const tokenImpl = await tokenFactory.deploy(0)
    await tokenImpl.waitForDeployment()
    const token = tokenImpl as unknown as TestERC20PermitAllowed

    const selfPermitTestFactory = await ethers.getContractFactory('SelfPermitTest')
    const selfPermitTestImpl = await selfPermitTestFactory.deploy()
    await selfPermitTestImpl.waitForDeployment()
    const selfPermitTest = selfPermitTestImpl as unknown as SelfPermitTest

    return { token, selfPermitTest }
  }

  let token: TestERC20PermitAllowed
  let selfPermitTest: SelfPermitTest

  beforeEach(async () => {
    ;({ token, selfPermitTest } = await loadFixture(fixture))
  })

  it('#permit (EIP-2612)', async () => {
    const value = 123n
    const owner = await wallet.getAddress()
    const spender = await other.getAddress()

    const sig = await getPermitSignature(wallet as any, token as any, spender, value)

    expect(await token.allowance(owner, spender)).to.eq(0n)

    const tokenAny = token as any
    await tokenAny['permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'](
      owner,
      spender,
      value,
      MaxUint256,
      sig.v,
      sig.r,
      sig.s
    )

    expect(await token.allowance(owner, spender)).to.eq(value)
  })

  describe('#selfPermit (EIP-2612)', () => {
    const value = 456n

    it('works', async () => {
      const owner = await wallet.getAddress()
      const testAddr = await selfPermitTest.getAddress()
      const tokenAddr = await token.getAddress()

      const sig = await getPermitSignature(wallet as any, token as any, testAddr, value)

      expect(await token.allowance(owner, testAddr)).to.eq(0n)
      await selfPermitTest.selfPermit(tokenAddr, value, MaxUint256, sig.v, sig.r, sig.s)
      expect(await token.allowance(owner, testAddr)).to.eq(value)
    })

    it('fails if permit is submitted externally', async () => {
      const owner = await wallet.getAddress()
      const testAddr = await selfPermitTest.getAddress()
      const tokenAddr = await token.getAddress()

      const sig = await getPermitSignature(wallet as any, token as any, testAddr, value)

      const tokenAny = token as any
      await tokenAny['permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'](
        owner,
        testAddr,
        value,
        MaxUint256,
        sig.v,
        sig.r,
        sig.s
      )
      expect(await token.allowance(owner, testAddr)).to.eq(value)

      await expect(
        selfPermitTest.selfPermit(tokenAddr, value, MaxUint256, sig.v, sig.r, sig.s)
      ).to.be.revertedWith('ERC20Permit: invalid signature')
    })
  })

  describe('#selfPermitIfNecessary (EIP-2612)', () => {
    const value = 789n

    it('works', async () => {
      const owner = await wallet.getAddress()
      const testAddr = await selfPermitTest.getAddress()
      const tokenAddr = await token.getAddress()

      const sig = await getPermitSignature(wallet as any, token as any, testAddr, value)

      expect(await token.allowance(owner, testAddr)).to.eq(0n)
      await selfPermitTest.selfPermitIfNecessary(tokenAddr, value, MaxUint256, sig.v, sig.r, sig.s)
      expect(await token.allowance(owner, testAddr)).to.eq(value)
    })

    it('does not fail if permit is submitted externally', async () => {
      const owner = await wallet.getAddress()
      const testAddr = await selfPermitTest.getAddress()
      const tokenAddr = await token.getAddress()

      const sig = await getPermitSignature(wallet as any, token as any, testAddr, value)

      const tokenAny = token as any
      await tokenAny['permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'](
        owner,
        testAddr,
        value,
        MaxUint256,
        sig.v,
        sig.r,
        sig.s
      )
      expect(await token.allowance(owner, testAddr)).to.eq(value)

      await selfPermitTest.selfPermitIfNecessary(tokenAddr, value, MaxUint256, sig.v, sig.r, sig.s)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────────
  // DAI-style (allowed) permit
  // ───────────────────────────────────────────────────────────────────────────────
  describe('#selfPermitAllowed (DAI-style)', () => {
    it('works', async () => {
      const owner = await wallet.getAddress()
      const testAddr = await selfPermitTest.getAddress()
      const tokenAddr = await token.getAddress()
      const currentNonce = await (token as any).nonces(owner)

      const sig = await getPermitAllowedSignature(wallet as any, token, testAddr, {
        nonce: BigInt(currentNonce),
        expiry: MaxUint256,
        allowed: true,
      })

      expect(await token.allowance(owner, testAddr)).to.eq(0n)
      await expect(
        selfPermitTest.selfPermitAllowed(tokenAddr, currentNonce, MaxUint256, sig.v, sig.r, sig.s)
      )
        .to.emit(token as any, 'Approval')
        .withArgs(owner, testAddr, MaxUint256)

      expect(await token.allowance(owner, testAddr)).to.eq(MaxUint256)
    })

    it('fails if permit is submitted externally', async () => {
      const owner = await wallet.getAddress()
      const testAddr = await selfPermitTest.getAddress()
      const currentNonce = await (token as any).nonces(owner)

      const sig = await getPermitAllowedSignature(wallet as any, token, testAddr, {
        nonce: BigInt(currentNonce),
        expiry: MaxUint256,
        allowed: true,
      })

      const tokenAny = token as any
      await tokenAny['permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)'](
        owner,
        testAddr,
        currentNonce,
        MaxUint256,
        true,
        sig.v,
        sig.r,
        sig.s
      )
      expect(await token.allowance(owner, testAddr)).to.eq(MaxUint256)

      await expect(
        selfPermitTest.selfPermitAllowed(await token.getAddress(), currentNonce, MaxUint256, sig.v, sig.r, sig.s)
      ).to.be.revertedWith('TestERC20PermitAllowed::permit: wrong nonce')
    })
  })

  describe('#selfPermitAllowedIfNecessary (DAI-style)', () => {
    it('works', async () => {
      const owner = await wallet.getAddress()
      const testAddr = await selfPermitTest.getAddress()
      const tokenAddr = await token.getAddress()
      const currentNonce = await (token as any).nonces(owner)

      const sig = await getPermitAllowedSignature(wallet as any, token, testAddr, {
        nonce: BigInt(currentNonce),
        expiry: MaxUint256,
        allowed: true,
      })

      expect(await token.allowance(owner, testAddr)).to.eq(0n)
      await expect(
        selfPermitTest.selfPermitAllowedIfNecessary(tokenAddr, currentNonce, MaxUint256, sig.v, sig.r, sig.s)
      )
        .to.emit(token as any, 'Approval')
        .withArgs(owner, testAddr, MaxUint256)

      expect(await token.allowance(owner, testAddr)).to.eq(MaxUint256)
    })

    it('skips if already max approved', async () => {
      const owner = await wallet.getAddress()
      const testAddr = await selfPermitTest.getAddress()
      const tokenAddr = await token.getAddress()

      await (token as any).approve(testAddr, MaxUint256)

      const currentNonce = await (token as any).nonces(owner)
      const sig = await getPermitAllowedSignature(wallet as any, token, testAddr, {
        nonce: BigInt(currentNonce),
        expiry: MaxUint256,
        allowed: true,
      })

      await expect(
        selfPermitTest.selfPermitAllowedIfNecessary(tokenAddr, currentNonce, MaxUint256, sig.v, sig.r, sig.s)
      ).to.not.emit(token as any, 'Approval')

      expect(await token.allowance(owner, testAddr)).to.eq(MaxUint256)
    })

    it('does not fail if permit is submitted externally', async () => {
      const owner = await wallet.getAddress()
      const testAddr = await selfPermitTest.getAddress()
      const currentNonce = await (token as any).nonces(owner)

      const sig = await getPermitAllowedSignature(wallet as any, token, testAddr, {
        nonce: BigInt(currentNonce),
        expiry: MaxUint256,
        allowed: true,
      })

      const tokenAny = token as any
      await tokenAny['permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)'](
        owner,
        testAddr,
        currentNonce,
        MaxUint256,
        true,
        sig.v,
        sig.r,
        sig.s
      )

      await selfPermitTest.selfPermitAllowedIfNecessary(await token.getAddress(), currentNonce, MaxUint256, sig.v, sig.r, sig.s)
    })
  })
})