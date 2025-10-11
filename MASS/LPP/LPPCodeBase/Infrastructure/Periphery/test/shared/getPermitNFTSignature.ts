// shared/getPermitNFTSignature.ts
import { MaxUint256, type BigNumberish, Signature, Wallet, type Provider } from 'ethers'
import type { NonfungiblePositionManager } from '../../typechain-types/periphery'

type PermitConfig = {
  nonce?: BigNumberish
  name?: string
  chainId?: number | bigint
  version?: string
}

async function resolveChainId(
  wallet: Wallet,
  positionManager: NonfungiblePositionManager
): Promise<bigint> {
  // Prefer the wallet’s provider; fall back to the contract’s runner/provider
  const provider: Provider | null =
    wallet.provider ??
    ((positionManager.runner && (positionManager.runner as any).provider)
      ? (positionManager.runner as any).provider
      : null)

  if (!provider) {
    throw new Error('No provider available to resolve chainId')
  }
  const { chainId } = await provider.getNetwork()
  // v6 returns bigint already, but coerce just in case
  return BigInt(chainId)
}

export default async function getPermitNFTSignature(
  wallet: Wallet,
  positionManager: NonfungiblePositionManager,
  spender: string,
  tokenId: BigNumberish,
  deadline: BigNumberish = MaxUint256,
  permitConfig?: PermitConfig
): Promise<Signature> {
  const [pmAddress, owner] = await Promise.all([
    positionManager.getAddress(), // v6
    wallet.getAddress(),
  ])

  const [nonce, name, version, chainId] = await Promise.all([
    permitConfig?.nonce ?? positionManager.positions(tokenId).then((p) => p.nonce),
    permitConfig?.name ?? positionManager.name(),
    permitConfig?.version ?? '1',
    permitConfig?.chainId ?? resolveChainId(wallet, positionManager),
  ])

  const sigHex = await wallet.signTypedData(
    {
      name,
      version,
      chainId,               // bigint or number is fine
      verifyingContract: pmAddress,
    },
    {
      Permit: [
        { name: 'spender', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    } as any,
    {
      owner,
      spender,
      tokenId,
      nonce,
      deadline,
    }
  )

  return Signature.from(sigHex) // v6 way to parse the signature
}