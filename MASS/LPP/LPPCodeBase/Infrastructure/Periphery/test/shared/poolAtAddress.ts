// shared/poolAtAddress.ts
import type { Signer } from 'ethers'
import { ILPPPool, ILPPPool__factory } from '../../typechain-types/protocol'

export default function poolAtAddress(address: string, signer: Signer): ILPPPool {
  return ILPPPool__factory.connect(address, signer)
}