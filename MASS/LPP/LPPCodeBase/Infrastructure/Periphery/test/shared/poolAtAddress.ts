import { abi as POOL_ABI } from '@lpp/lpp-protocol/artifacts/contracts/LPPPool.sol/LPPPool.json'
import { Contract, Wallet } from 'ethers'
import { ILPPPool } from '../../typechain'

export default function poolAtAddress(address: string, wallet: Wallet): ILPPPool {
  return new Contract(address, POOL_ABI, wallet) as ILPPPool
}
