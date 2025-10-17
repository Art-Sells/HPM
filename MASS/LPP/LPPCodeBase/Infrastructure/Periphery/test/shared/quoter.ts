import type { Wallet } from 'ethers'
import type { MockTimeNonfungiblePositionManager } from '../../typechain-types/periphery'
import { FeeAmount, TICK_SPACINGS } from './constants.ts'
import { encodePriceSqrt } from './encodePriceSqrt.ts'
import { getMaxTick, getMinTick } from './ticks.ts'
import { expandTo18Decimals } from './expandTo18Decimals.ts'

export async function createPool(
  nft: MockTimeNonfungiblePositionManager,
  wallet: Wallet,
  tokenAddressA: string,
  tokenAddressB: string
) {
  if (tokenAddressA.toLowerCase() > tokenAddressB.toLowerCase())
    [tokenAddressA, tokenAddressB] = [tokenAddressB, tokenAddressA]

  await nft.createAndInitializePoolIfNecessary(tokenAddressA, tokenAddressB, FeeAmount.ZERO, encodePriceSqrt(1, 1))

  const liquidityParams = {
    token0: tokenAddressA,
    token1: tokenAddressB,
    fee: FeeAmount.ZERO,
    tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
    tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
    recipient: wallet.address,
    amount0Desired: 1000000,
    amount1Desired: 1000000,
    amount0Min: 0,
    amount1Min: 0,
    deadline: 1,
  }

  return nft.mint(liquidityParams)
}

export async function createPoolWithMultiplePositions(
  nft: MockTimeNonfungiblePositionManager,
  wallet: Wallet,
  tokenAddressA: string,
  tokenAddressB: string
) {
  if (tokenAddressA.toLowerCase() > tokenAddressB.toLowerCase())
    [tokenAddressA, tokenAddressB] = [tokenAddressB, tokenAddressA]

  await nft.createAndInitializePoolIfNecessary(tokenAddressA, tokenAddressB, FeeAmount.ZERO, encodePriceSqrt(1, 1))

  const liquidityParams = {
    token0: tokenAddressA,
    token1: tokenAddressB,
    fee: FeeAmount.ZERO,
    tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
    tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
    recipient: wallet.address,
    amount0Desired: expandTo18Decimals(1_000_000),
    amount1Desired: expandTo18Decimals(1_000_000),
    amount0Min: 0,
    amount1Min: 0,
    deadline: 1,
  }

  await nft.mint(liquidityParams)

  const liquidityParams2 = {
    token0: tokenAddressA,
    token1: tokenAddressB,
    fee: FeeAmount.ZERO,
    tickLower: -60,
    tickUpper: 60,
    recipient: wallet.address,
    amount0Desired: expandTo18Decimals(1_000_000),
    amount1Desired: expandTo18Decimals(1_000_000),
    amount0Min: 0,
    amount1Min: 0,
    deadline: 1,
  }

  await nft.mint(liquidityParams2)

  const liquidityParams3 = {
    token0: tokenAddressA,
    token1: tokenAddressB,
    fee: FeeAmount.ZERO,
    tickLower: -120,
    tickUpper: 120,
    recipient: wallet.address,
    amount0Desired: expandTo18Decimals(1_000_000),
    amount1Desired: expandTo18Decimals(1_000_000),
    amount0Min: 0,
    amount1Min: 0,
    deadline: 1,
  }

  return nft.mint(liquidityParams3)
}

export async function createPoolWithZeroTickInitialized(
  nft: MockTimeNonfungiblePositionManager,
  wallet: Wallet,
  tokenAddressA: string,
  tokenAddressB: string
) {
  if (tokenAddressA.toLowerCase() > tokenAddressB.toLowerCase())
    [tokenAddressA, tokenAddressB] = [tokenAddressB, tokenAddressA]

  await nft.createAndInitializePoolIfNecessary(tokenAddressA, tokenAddressB, FeeAmount.ZERO, encodePriceSqrt(1, 1))

  const liquidityParams = {
    token0: tokenAddressA,
    token1: tokenAddressB,
    fee: FeeAmount.ZERO,
    tickLower: getMinTick(TICK_SPACINGS[FeeAmount.ZERO]),
    tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.ZERO]),
    recipient: wallet.address,
    amount0Desired: expandTo18Decimals(1_000_000),
    amount1Desired: expandTo18Decimals(1_000_000),
    amount0Min: 0,
    amount1Min: 0,
    deadline: 1,
  }

  await nft.mint(liquidityParams)

  const liquidityParams2 = {
    token0: tokenAddressA,
    token1: tokenAddressB,
    fee: FeeAmount.ZERO,
    tickLower: 0,
    tickUpper: 60,
    recipient: wallet.address,
    amount0Desired: expandTo18Decimals(1_000_000),
    amount1Desired: expandTo18Decimals(1_000_000),
    amount0Min: 0,
    amount1Min: 0,
    deadline: 1,
  }

  await nft.mint(liquidityParams2)

  const liquidityParams3 = {
    token0: tokenAddressA,
    token1: tokenAddressB,
    fee: FeeAmount.ZERO,
    tickLower: -120,
    tickUpper: 0,
    recipient: wallet.address,
    amount0Desired: expandTo18Decimals(1_000_000),
    amount1Desired: expandTo18Decimals(1_000_000),
    amount0Min: 0,
    amount1Min: 0,
    deadline: 1,
  }

  return nft.mint(liquidityParams3)
}
