// test/shared/utilities.ts
import bn from 'bignumber.js'
import hre from 'hardhat'
const { ethers } = hre

import type { BigNumberish, ContractTransactionResponse, Wallet } from 'ethers'

import type { TestLPPCallee } from '../../typechain-types/protocol'
import type { TestLPPRouter } from '../../typechain-types/protocol'
import type { MockTimeLPPPool } from '../../typechain-types/protocol'
import type { TestERC20 } from '../../typechain-types/protocol'
import type { ILPPPool } from '../../typechain-types/protocol'

// ---- Fee tiers: ZERO only (enum-free for ESM strip-only) ----
export const FeeAmount = { ZERO: 0 } as const
export type FeeAmount = typeof FeeAmount[keyof typeof FeeAmount]
export function expandTo18Decimals(n: number): bigint {
  return BigInt(n) * (10n ** 18n)
}
export const TICK_SPACINGS: Record<number, number> = {
  [FeeAmount.ZERO]: 1,
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
bn.config({ EXPONENTIAL_AT: 999999, DECIMAL_PLACES: 40 })

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

  const digest = ethers.keccak256(
    ethers.concat([
      ethers.getBytes('0xff'),
      ethers.getBytes(factoryAddress),
      ethers.getBytes(salt),
      ethers.getBytes(initCodeHash),
    ])
  )

  return ethers.getAddress('0x' + digest.slice(-40))
}

export function getPositionKey(addr: string, lowerTick: number, upperTick: number): string {
  return ethers.keccak256(ethers.solidityPacked(['address', 'int24', 'int24'], [addr, lowerTick, upperTick]))
}

// ---- pool interaction types (ethers v6: ContractTransactionResponse) ----
export type SupplicateFunction = (
  amount: BigNumberish,
  to: Wallet | string,
  sqrtPriceLimitX96?: BigNumberish
) => Promise<ContractTransactionResponse>

export type SupplicateToPriceFunction = (
  sqrtPriceX96: BigNumberish,
  to: Wallet | string
) => Promise<ContractTransactionResponse>

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
  supplicateToLowerPrice: SupplicateToPriceFunction
  supplicateToHigherPrice: SupplicateToPriceFunction
  supplicateExact0For1: SupplicateFunction
  supplicate0ForExact1: SupplicateFunction
  supplicateExact1For0: SupplicateFunction
  supplicate1ForExact0: SupplicateFunction
  flash: FlashFunction
  mint: MintFunction
}

// small helper: resolve a Wallet | string to an address
async function resolveTo(to: Wallet | string): Promise<string> {
  if (typeof to === 'string') return to
  return ('address' in to && typeof (to as any).address === 'string')
    ? (to as any).address
    : await (to as any).getAddress()
}

export function createPoolFunctions({
  supplicateTarget,
  token0,
  token1,
  pool,
}: {
  supplicateTarget: TestLPPCallee
  token0: TestERC20
  token1: TestERC20
  pool: MockTimeLPPPool
}): PoolFunctions {
  const callee = supplicateTarget as any

  async function supplicateToSqrtPrice(
    inputToken: TestERC20,
    targetPrice: BigNumberish,
    to: Wallet | string
  ): Promise<ContractTransactionResponse> {
    const method =
      inputToken === token0 ? callee.supplicateToLowerSqrtPrice : callee.supplicateToHigherSqrtPrice

    await inputToken.approve(await supplicateTarget.getAddress(), ethers.MaxUint256)
    const toAddress = await resolveTo(to)
    return method(await pool.getAddress(), targetPrice, toAddress)
  }

  async function supplicate(
    inputToken: TestERC20,
    [amountIn, amountOut]: [BigNumberish, BigNumberish],
    to: Wallet | string,
    sqrtPriceLimitX96?: BigNumberish
  ): Promise<ContractTransactionResponse> {
    const exactInput = toBigInt(amountOut) === 0n

    const method =
      inputToken === token0
        ? (exactInput ? callee.supplicateExact0For1 : callee.supplicate0ForExact1)
        : (exactInput ? callee.supplicateExact1For0 : callee.supplicate1ForExact0)

    if (typeof sqrtPriceLimitX96 === 'undefined') {
      sqrtPriceLimitX96 = inputToken === token0 ? (MIN_SQRT_RATIO + 1n) : (MAX_SQRT_RATIO - 1n)
    }

    await inputToken.approve(await supplicateTarget.getAddress(), ethers.MaxUint256)
    const toAddress = await resolveTo(to)
    return method(await pool.getAddress(), exactInput ? amountIn : amountOut, toAddress, sqrtPriceLimitX96)
  }

  const supplicateToLowerPrice: SupplicateToPriceFunction = (sqrtPriceX96, to) =>
    supplicateToSqrtPrice(token0, sqrtPriceX96, to)

  const supplicateToHigherPrice: SupplicateToPriceFunction = (sqrtPriceX96, to) =>
    supplicateToSqrtPrice(token1, sqrtPriceX96, to)

  const supplicateExact0For1: SupplicateFunction = (amount, to, limit) =>
    supplicate(token0, [amount, 0], to, limit)

  const supplicate0ForExact1: SupplicateFunction = (amount, to, limit) =>
    supplicate(token0, [0, amount], to, limit)

  const supplicateExact1For0: SupplicateFunction = (amount, to, limit) =>
    supplicate(token1, [amount, 0], to, limit)

  const supplicate1ForExact0: SupplicateFunction = (amount, to, limit) =>
    supplicate(token1, [0, amount], to, limit)

  // --- Call ILPPPoolActions.mint on the pool, from the callee address, so lppMintCallback triggers on TestLPPCallee ---
  const mint: MintFunction = async (recipient, tickLower, tickUpper, liquidity) => {
    // Let TestLPPCallee pull owed tokens in lppMintCallback
    await token0.approve(await supplicateTarget.getAddress(), ethers.MaxUint256)
    await token1.approve(await supplicateTarget.getAddress(), ethers.MaxUint256)

    // Data expected by your lppMintCallback (decoded as address sender)
    const data = ethers.AbiCoder.defaultAbiCoder().encode(['address'], [recipient])

    const calleeAddr = await supplicateTarget.getAddress()

    // Impersonate the callee so msg.sender in pool.mint == TestLPPCallee
    await hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [calleeAddr],
    })
    await hre.network.provider.send('hardhat_setBalance', [
      calleeAddr,
      '0x56BC75E2D63100000', // 100 ETH
    ])
    const calleeSigner = await ethers.getSigner(calleeAddr)

    try {
      // Use the ILPPPool type from typechain for compile-time ABI correctness
      const poolAsILPP = (await ethers.getContractAt(
        'ILPPPool',
        await pool.getAddress(),
        calleeSigner
      )) as unknown as ILPPPool

      return await (poolAsILPP as any).mint(
        recipient,
        tickLower as any,
        tickUpper as any,
        liquidity as any,
        data
      )
    } finally {
      await hre.network.provider.request({
        method: 'hardhat_stopImpersonatingAccount',
        params: [calleeAddr],
      })
    }
  }

  const flash: FlashFunction = async (amount0, amount1, to, pay0?: BigNumberish, pay1?: BigNumberish) => {
    const fee = toBigInt(await pool.fee())
    const amt0 = toBigInt(amount0)
    const amt1 = toBigInt(amount1)

    const ceilDivFee = (x: bigint) => (x * fee + 999_999n) / 1_000_000n

    const p0 = (typeof pay0 === 'undefined') ? (ceilDivFee(amt0) + amt0) : toBigInt(pay0)
    const p1 = (typeof pay1 === 'undefined') ? (ceilDivFee(amt1) + amt1) : toBigInt(pay1)

    const toAddress = await resolveTo(to)
    return (supplicateTarget as any).flash(await pool.getAddress(), toAddress, amount0, amount1, p0, p1)
  }

  return {
    supplicateToLowerPrice,
    supplicateToHigherPrice,
    supplicateExact0For1,
    supplicate0ForExact1,
    supplicateExact1For0,
    supplicate1ForExact0,
    mint,
    flash,
  }
}

export interface MultiPoolFunctions {
  supplicateForExact0Multi: SupplicateFunction
  supplicateForExact1Multi: SupplicateFunction
}

export function createMultiPoolFunctions({
  inputToken,
  supplicateTarget,
  poolInput,
  poolOutput,
}: {
  inputToken: TestERC20
  supplicateTarget: TestLPPRouter
  poolInput: MockTimeLPPPool
  poolOutput: MockTimeLPPPool
}): MultiPoolFunctions {
  const router = supplicateTarget as any

  async function supplicateForExact0Multi(amountOut: BigNumberish, to: Wallet | string): Promise<ContractTransactionResponse> {
    await inputToken.approve(await supplicateTarget.getAddress(), ethers.MaxUint256)
    const toAddress = await resolveTo(to)
    return router.supplicateForExact0Multi(
      toAddress,
      await poolInput.getAddress(),
      await poolOutput.getAddress(),
      amountOut
    )
  }

  async function supplicateForExact1Multi(amountOut: BigNumberish, to: Wallet | string): Promise<ContractTransactionResponse> {
    await inputToken.approve(await supplicateTarget.getAddress(), ethers.MaxUint256)
    const toAddress = await resolveTo(to)
    return router.supplicateForExact1Multi(
      toAddress,
      await poolInput.getAddress(),
      await poolOutput.getAddress(),
      amountOut
    )
  }

  return {
    supplicateForExact0Multi,
    supplicateForExact1Multi,
  }
}