// test/shared/poolAtAddress.ts
import type { Signer } from 'ethers'
import { Contract } from 'ethers'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
// pull ABI via CJS require to bypass ESM JSON + folder headaches
const ILPPPoolJson = require('@lpp/lpp-protocol/artifacts/contracts/interfaces/ILPPPool.sol/ILPPPool.json')
const ILPPPoolABI = ILPPPoolJson.abi as any

export default function poolAtAddress(address: string, signer: Signer): Contract {
  return new Contract(address, ILPPPoolABI, signer)
}