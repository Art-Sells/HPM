// test/shared/tokenSort.ts
import type { AddressLike } from 'ethers'

export type Addressish = string | { address: string } | { target: AddressLike }

function addrOfSync(x: Addressish): string {
  if (typeof x === 'string') return x
  const anyx = x as any
  if (typeof anyx.target === 'string') return anyx.target
  if (typeof anyx.address === 'string') return anyx.address
  throw new Error('addrOfSync: target/address is not a string; use sortedTokensAsync()')
}

export function compareToken<A extends Addressish, B extends Addressish>(a: A, b: B): -1 | 1 {
  return addrOfSync(a).toLowerCase() < addrOfSync(b).toLowerCase() ? -1 : 1
}

export function sortedTokens<A extends Addressish, B extends Addressish>(a: A, b: B): [A, B] | [B, A] {
  return compareToken(a, b) < 0 ? [a, b] : [b, a]
}

// Full async resolver for anything AddressLike/Addressable
async function resolveAddress(x: any): Promise<string> {
  if (typeof x === 'string') return x
  if (typeof x?.target === 'string') return x.target
  if (typeof x?.address === 'string') return x.address
  if (typeof x?.getAddress === 'function') return await x.getAddress()
  throw new Error('resolveAddress: cannot resolve address')
}

export async function sortedTokensAsync<A, B>(a: A, b: B): Promise<[A, B] | [B, A]> {
  const [aa, bb] = await Promise.all([resolveAddress(a), resolveAddress(b)])
  return aa.toLowerCase() < bb.toLowerCase() ? [a, b] : [b, a]
}