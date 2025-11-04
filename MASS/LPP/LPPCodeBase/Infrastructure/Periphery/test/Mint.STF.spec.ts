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
  it('reverts with STF when transferFrom fails (allowance = 0)', async () => {
    const { tokens, nft } = await loadFixture(setup)
    const [wallet] = await ethers.getSigners()

    const token0Addr = await tokens[0].getAddress()
    const token1Addr = await tokens[1].getAddress()

    const fee = FeeAmount.ZERO
    const tickSpacing = TICK_SPACINGS[fee]

    // init pool at price 1 (tick 0)
    await nft.createAndInitializePoolIfNecessary(
      token0Addr,
      token1Addr,
      fee,
      encodePriceSqrt(1, 1)
    )

    // force failure on token0 transfer
    const nftAddr = await nft.getAddress()
    await tokens[0].approve(nftAddr, 0)

    const now = (await ethers.provider.getBlock('latest'))!.timestamp

    const params = {
      token0: token0Addr,
      token1: token1Addr,
      fee,
      tickLower: getMinTick(tickSpacing),
      tickUpper: getMaxTick(tickSpacing),
      // use real amounts so we reach TransferHelper path
      amount0Desired: expandTo18Decimals(1), // 1e18
      amount1Desired: expandTo18Decimals(1), // 1e18
      amount0Min: 0,
      amount1Min: 0,
      recipient: await wallet.getAddress(),
      deadline: now + 10_000,
    }

    // inline ABI for the custom error; no new .sol, no deployment
    const errorAbi = ['error STF()']
    const fakeForAbi = new ethers.Contract(
      await nft.getAddress(),                 // any address is fine
      new ethers.Interface(errorAbi),
      ethers.provider
    )

    await expect(nft.mint(params)).to.be.revertedWithCustomError(fakeForAbi, 'STF')
    // if your TransferHelper is the older string version, this also works:
    // await expect(nft.mint(params)).to.be.revertedWith('STF')
  })
})