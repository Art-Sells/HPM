// Periphery/test/shared/poolAddressLib.ts
// Periphery/test/shared/poolAddressLib.ts
import hre from 'hardhat'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { ethers, artifacts } = hre

// IMPORTANT: hash the impl artifact that your Factory will actually deploy
const implPath = require.resolve(
  '@lpp/lpp-protocol/artifacts/contracts/LPPPool.sol/LPPPool.json'
)
console.log('Using LPPPool artifact at:', implPath) // <-- keep for debugging

const LPPPoolImplJson = require(implPath)

export async function getInitHash(): Promise<string> {
  const bytecode: string = LPPPoolImplJson.bytecode
  if (!bytecode || bytecode === '0x') {
    throw new Error('Impl bytecode missing—check artifact path')
  }
  return ethers.keccak256(bytecode)
}

// (Optional helper if you need it in tests)
export async function computeExpectedPool(
  factoryAddr: string,
  token0: string,
  token1: string,
  fee: number
): Promise<string> {
  const initCodeHash = await getInitHash()
  const salt = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['address','address','uint24'], [token0, token1, fee])
  )
  return ethers.getCreate2Address(factoryAddr, salt, initCodeHash)
}