// poolAddressLib.ts
import hre from 'hardhat'
import type { ILPPFactory } from '../../typechain-types/protocol'
const { ethers } = hre

export async function computeExpectedPool(
  factoryAddr: string,
  token0: string,
  token1: string,
  fee: number
): Promise<string> {
  // Use the artifact you actually have
  const factory = (await ethers.getContractAt(
    'ILPPFactory',
    factoryAddr
  )) as unknown as ILPPFactory

  // ethers v6: static call through the method object
  try {
    return await (factory as any).getFunction('createPool').staticCall(token0, token1, fee)
  } catch {
    if ((factory as any).getPool)  return await (factory as any).getPool(token0, token1, fee)
    if ((factory as any).pools)    return await (factory as any).pools(token0, token1, fee)
    throw new Error('Factory cannot compute or read pool address')
  }
}