// test/shared/permit.ts
import type { Signer } from 'ethers'
import { MaxUint256, Signature } from 'ethers'
import type { TestERC20, TestERC20PermitAllowed } from '../../typechain-types/periphery'

function toBig(x: any): bigint {
  if (typeof x === 'bigint') return x
  if (typeof x === 'number') return BigInt(x)
  if (typeof x === 'string') return BigInt(x)
  if (x && typeof x.toString === 'function') return BigInt(x.toString())
  return BigInt(x)
}

/** EIP-2612 (value-based) */
export async function getPermitSignature(
  wallet: Signer,
  token: TestERC20 | TestERC20PermitAllowed | any,
  spender: string,
  value: bigint = MaxUint256,
  deadline: bigint = MaxUint256
): Promise<Signature> {
  const owner = await wallet.getAddress()
  const [nonceRaw, name, net] = await Promise.all([
    token.nonces(owner),
    token.name(),
    wallet.provider!.getNetwork(),
  ])
  const verifyingContract: string = await token.getAddress()
  const nonce = toBig(nonceRaw)
  const chainId = Number(net.chainId)

  const domain = { name, version: '1', chainId, verifyingContract }
  const types = {
    Permit: [
      { name: 'owner',    type: 'address' },
      { name: 'spender',  type: 'address' },
      { name: 'value',    type: 'uint256' },
      { name: 'nonce',    type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  }
  const message = { owner, spender, value, nonce, deadline }

  const sigHex = await (wallet as any).signTypedData(domain, types as any, message)
  return Signature.from(sigHex)
}

/** “DAI-style” entry point, but your contract forwards to EIP-2612.
 *  So we sign an EIP-2612 message with value = (allowed ? MaxUint256 : 0) and deadline = expiry.
 */
export async function getPermitAllowedSignature(
  wallet: Signer,
  token: TestERC20PermitAllowed | any,
  spender: string,
  cfg?: { nonce?: bigint; expiry?: bigint; allowed?: boolean }
): Promise<Signature> {
  const holder = await wallet.getAddress()
  const [nonceRaw, name, net] = await Promise.all([
    cfg?.nonce ?? token.nonces(holder),
    token.name(),
    wallet.provider!.getNetwork(),
  ])
  const verifyingContract: string = await token.getAddress()
  const nonce = toBig(nonceRaw)
  const chainId = Number(net.chainId)

  const expiry = toBig(cfg?.expiry ?? MaxUint256)
  const allowed = cfg?.allowed ?? true
  const value = allowed ? MaxUint256 : 0n

  // EIP-2612 domain & struct (NOT DAI-style)
  const domain = { name, version: '1', chainId, verifyingContract }
  const types = {
    Permit: [
      { name: 'owner',    type: 'address' },
      { name: 'spender',  type: 'address' },
      { name: 'value',    type: 'uint256' },
      { name: 'nonce',    type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  }
  const message = { owner: holder, spender, value, nonce, deadline: expiry }

  const sigHex = await (wallet as any).signTypedData(domain, types as any, message)
  return Signature.from(sigHex)
}