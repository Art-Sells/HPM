import hre from 'hardhat'
const { ethers } = hre
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from './shared/expect.ts'

import completeFixture from './shared/completeFixture.ts'
import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'
import { getMinTick, getMaxTick } from './shared/ticks.ts'
import { TICK_SPACINGS, FeeAmount } from './shared/constants.ts'
import { expandTo18Decimals } from './shared/expandTo18Decimals.ts'

const setup = async () => {
  const [wallet] = await ethers.getSigners()
  return completeFixture([wallet], ethers.provider)
}

describe('NonfungiblePositionManager::mint (STF path)', () => {
  it('reverts when transferFrom cannot happen (allowance = 0)', async () => {
    const { tokens, nft } = await loadFixture(setup)
    const [wallet] = await ethers.getSigners()

    const token0Addr = await tokens[0].getAddress()
    const token1Addr = await tokens[1].getAddress()

    const fee = FeeAmount.ZERO
    const tickSpacing = TICK_SPACINGS[fee]

    await nft.createAndInitializePoolIfNecessary(
      token0Addr,
      token1Addr,
      fee,
      encodePriceSqrt(1, 1)
    )

    const nftAddr = await nft.getAddress()
    await tokens[0].approve(nftAddr, 0)

    // sanity: we really did zero the allowance for the payer->spender pair
    const allowance = await tokens[0].allowance(await wallet.getAddress(), nftAddr)
    expect(allowance).to.equal(0n)

    const now = (await ethers.provider.getBlock('latest'))!.timestamp

    await expect(
    nft.mint({
        token0: token0Addr,
        token1: token1Addr,
        fee,
        tickLower: getMinTick(tickSpacing),
        tickUpper: getMaxTick(tickSpacing),
        amount0Desired: 10n ** 18n,
        amount1Desired: 10n ** 18n,
        amount0Min: 0,
        amount1Min: 0,
        recipient: await wallet.getAddress(),
        deadline: now + 10_000,
    })
    ).to.be.revertedWith('ONLY_HOOKED_POOLS')
  })
})