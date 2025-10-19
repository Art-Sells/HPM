// test/shared/utilities.ts
import bn from 'bignumber.js'
import hre from 'hardhat'
const { ethers } = hre

import type { BigNumberish, ContractTransactionResponse, Wallet } from 'ethers'

import type { TestLPPCallee } from '../../typechain-types/protocol'
import type { TestLPPRouter } from '../../typechain-types/protocol'
import type { MockTimeLPPPool } from '../../typechain-types/protocol'
import type { TestERC20 } from '../../typechain-types/protocol'

// ---- Fee tiers: ZERO only (enum-free for ESM strip-only) ----
export const FeeAmount = { ZERO: 0 } as const
export type FeeAmount = typeof FeeAmount[keyof typeof FeeAmount]

export const TICK_SPACINGS: Record<number, number> = {
  [FeeAmount.ZERO]: 1, // adjust if your ZERO tier spacing differs
}

// ---- BigInt helpers & constants (ethers v6) ----
export const MaxUint128 = (1n << 128n) - 1n

export const getMinTick = (tickSpacing: number) => Math.ceil(-887272 / tickSpacing) * tickSpacing
export const getMaxTick = (tickSpacing: number) => Math.floor(887272 / tickSpacing) * tickSpacing
export const getMaxLiquidityPerTick = (tickSpacing: number) => {
  // (2^128 - 1) / (#ticks)
  const span = BigInt((getMaxTick(tickSpacing) - getMinTick(tickSpacing)) / tickSpacing + 1)
  return ((1n << 128n) - 1n) / span
}

export const MIN_SQRT_RATIO = 4295128739n
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n

// ---- math utils ----
const toBigInt = (x: BigNumberish): bigint => BigInt(x as any)

// keep bignumber.js for sqrt of rational -> return as bigint
bn.config({ EXPONENTIAL_AT: 999999, DECIMAL_PLACES: 40 })

// returns the sqrt price as a Q64.96 (bigint)
export function encodePriceSqrt(reserve1: BigNumberish, reserve0: BigNumberish): bigint {
  return BigInt(
    new bn(reserve1.toString())
      .div(reserve0.toString())
      .sqrt()
      .multipliedBy(new bn(2).pow(96))
      .integerValue(3)
      .toString()
  )
}

// ---- create2 helpers (ethers v6 utils moved to top-level) ----
export function getCreate2Address(
  factoryAddress: string,
  [tokenA, tokenB]: [string, string],
  fee: number,
  bytecode: string
): string {
  const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA]

  const abi = ethers.AbiCoder.defaultAbiCoder()
  const encoded = abi.encode(['address', 'address', 'uint24'], [token0, token1, fee])

  const salt = ethers.keccak256(encoded)
  const initCodeHash = ethers.keccak256(bytecode)

  // keccak256(0xff ++ factory ++ salt ++ init_code_hash)[12:]
  const digest = ethers.keccak256(
    ethers.concat([ethers.getBytes('0xff'), ethers.getBytes(factoryAddress), ethers.getBytes(salt), ethers.getBytes(initCodeHash)])
  )

  return ethers.getAddress('0x' + digest.slice(-40))
}

export function getPositionKey(addr: string, lowerTick: number, upperTick: number): string {
  return ethers.keccak256(ethers.solidityPacked(['address', 'int24', 'int24'], [addr, lowerTick, upperTick]))
}

// ---- pool interaction types (ethers v6: ContractTransactionResponse) ----
export type SwapFunction = (
  amount: BigNumberish,
  to: Wallet | string,
  sqrtPriceLimitX96?: BigNumberish
) => Promise<ContractTransactionResponse>

export type SwapToPriceFunction = (sqrtPriceX96: BigNumberish, to: Wallet | string) => Promise<ContractTransactionResponse>

export type FlashFunction = (
  amount0: BigNumberish,
  amount1: BigNumberish,
  to: Wallet | string,
  pay0?: BigNumberish,
  pay1?: BigNumberish
) => Promise<ContractTransactionResponse>

export type MintFunction = (
  recipient: string,
  tickLower: BigNumberish,
  tickUpper: BigNumberish,
  liquidity: BigNumberish
) => Promise<ContractTransactionResponse>

export interface PoolFunctions {
  swapToLowerPrice: SwapToPriceFunction
  swapToHigherPrice: SwapToPriceFunction
  swapExact0For1: SwapFunction
  swap0ForExact1: SwapFunction
  swapExact1For0: SwapFunction
  swap1ForExact0: SwapFunction
  flash: FlashFunction
  mint: MintFunction
}

// small helper: resolve a Wallet | string to an address
async function resolveTo(to: Wallet | string): Promise<string> {
  if (typeof to === 'string') return to
  // Wallet has .address; Hardhat signers have getAddress()
  return ('address' in to && typeof (to as any).address === 'string') ? (to as any).address : await (to as any).getAddress()
}

export function createPoolFunctions({
  swapTarget,
  token0,
  token1,
  pool,
}: {
  swapTarget: TestLPPCallee
  token0: TestERC20
  token1: TestERC20
  pool: MockTimeLPPPool
}): PoolFunctions {
  // cast once for convenience where typechain signatures might not include helper funcs
  const callee = swapTarget as any

  async function swapToSqrtPrice(
    inputToken: TestERC20,
    targetPrice: BigNumberish,
    to: Wallet | string
  ): Promise<ContractTransactionResponse> {
    const method =
      inputToken === token0 ? callee.swapToLowerSqrtPrice : callee.swapToHigherSqrtPrice

    await inputToken.approve(await swapTarget.getAddress(), ethers.MaxUint256)
    const toAddress = await resolveTo(to)
    return method(await pool.getAddress(), targetPrice, toAddress)
  }

  async function swap(
    inputToken: TestERC20,
    [amountIn, amountOut]: [BigNumberish, BigNumberish],
    to: Wallet | string,
    sqrtPriceLimitX96?: BigNumberish
  ): Promise<ContractTransactionResponse> {
    const exactInput = toBigInt(amountOut) === 0n

    const method =
      inputToken === token0
        ? exactInput
          ? callee.swapExact0For1
          : callee.swap0ForExact1
        : exactInput
          ? callee.swapExact1For0
          : callee.swap1ForExact0

    if (typeof sqrtPriceLimitX96 === 'undefined') {
      sqrtPriceLimitX96 = inputToken === token0 ? (MIN_SQRT_RATIO + 1n) : (MAX_SQRT_RATIO - 1n)
    }

    await inputToken.approve(await swapTarget.getAddress(), ethers.MaxUint256)
    const toAddress = await resolveTo(to)
    return method(await pool.getAddress(), exactInput ? amountIn : amountOut, toAddress, sqrtPriceLimitX96)
  }

  const swapToLowerPrice: SwapToPriceFunction = (sqrtPriceX96, to) =>
    swapToSqrtPrice(token0, sqrtPriceX96, to)

  const swapToHigherPrice: SwapToPriceFunction = (sqrtPriceX96, to) =>
    swapToSqrtPrice(token1, sqrtPriceX96, to)

  const swapExact0For1: SwapFunction = (amount, to, limit) =>
    swap(token0, [amount, 0], to, limit)

  const swap0ForExact1: SwapFunction = (amount, to, limit) =>
    swap(token0, [0, amount], to, limit)

  const swapExact1For0: SwapFunction = (amount, to, limit) =>
    swap(token1, [amount, 0], to, limit)

  const swap1ForExact0: SwapFunction = (amount, to, limit) =>
    swap(token1, [0, amount], to, limit)

  const mint: MintFunction = async (recipient, tickLower, tickUpper, liquidity) => {
    await token0.approve(await swapTarget.getAddress(), ethers.MaxUint256)
    await token1.approve(await swapTarget.getAddress(), ethers.MaxUint256)
    return (swapTarget as any).mint(await pool.getAddress(), recipient, tickLower, tickUpper, liquidity)
  }

  const flash: FlashFunction = async (amount0, amount1, to, pay0?: BigNumberish, pay1?: BigNumberish) => {
    const fee = toBigInt(await pool.fee())
    const amt0 = toBigInt(amount0)
    const amt1 = toBigInt(amount1)

    const ceilDivFee = (x: bigint) => (x * fee + 999_999n) / 1_000_000n

    const p0 = (typeof pay0 === 'undefined') ? (ceilDivFee(amt0) + amt0) : toBigInt(pay0)
    const p1 = (typeof pay1 === 'undefined') ? (ceilDivFee(amt1) + amt1) : toBigInt(pay1)

    const toAddress = await resolveTo(to)
    return (swapTarget as any).flash(await pool.getAddress(), toAddress, amount0, amount1, p0, p1)
  }

  return {
    swapToLowerPrice,
    swapToHigherPrice,
    swapExact0For1,
    swap0ForExact1,
    swapExact1For0,
    swap1ForExact0,
    mint,
    flash,
  }
}

export interface MultiPoolFunctions {
  swapForExact0Multi: SwapFunction
  swapForExact1Multi: SwapFunction
}

export function createMultiPoolFunctions({
  inputToken,
  swapTarget,
  poolInput,
  poolOutput,
}: {
  inputToken: TestERC20
  swapTarget: TestLPPRouter
  poolInput: MockTimeLPPPool
  poolOutput: MockTimeLPPPool
}): MultiPoolFunctions {
  const router = swapTarget as any

  async function swapForExact0Multi(amountOut: BigNumberish, to: Wallet | string): Promise<ContractTransactionResponse> {
    await inputToken.approve(await swapTarget.getAddress(), ethers.MaxUint256)
    const toAddress = await resolveTo(to)
    return router.swapForExact0Multi(
      toAddress,
      await poolInput.getAddress(),
      await poolOutput.getAddress(),
      amountOut
    )
  }

  async function swapForExact1Multi(amountOut: BigNumberish, to: Wallet | string): Promise<ContractTransactionResponse> {
    await inputToken.approve(await swapTarget.getAddress(), ethers.MaxUint256)
    const toAddress = await resolveTo(to)
    return router.swapForExact1Multi(
      toAddress,
      await poolInput.getAddress(),
      await poolOutput.getAddress(),
      amountOut
    )
  }

  return {
    swapForExact0Multi,
    swapForExact1Multi,
  }
}