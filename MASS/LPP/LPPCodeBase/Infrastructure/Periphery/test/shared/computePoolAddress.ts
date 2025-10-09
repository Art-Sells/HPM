import { keccak256, getAddress, AbiCoder } from 'ethers'
const LPPPoolArtifact = require('../../../Protocol/artifacts/contracts/LPPPool.sol/LPPPool.json')

export const POOL_BYTECODE_HASH = keccak256(LPPPoolArtifact.bytecode)

export function computePoolAddress(factoryAddress: string, [tokenA, tokenB]: [string, string], fee: number): string {
  const [token0, token1] =
    tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA]

  const abiCoder = new AbiCoder()
  const constructorArgumentsEncoded = abiCoder.encode(
    ['address', 'address', 'uint24'],
    [token0, token1, fee]
  )

  const create2Inputs = [
    '0xff',
    factoryAddress,
    // salt
    keccak256(constructorArgumentsEncoded),
    // init code hash
    POOL_BYTECODE_HASH,
  ]

  const sanitizedInputs = `0x${create2Inputs.map((i) => i.slice(2)).join('')}`
  return getAddress(`0x${keccak256(sanitizedInputs).slice(-40)}`)
}