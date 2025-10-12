// test/shared/computePoolAddress.ts
import { keccak256, getAddress, AbiCoder, solidityPacked, getBytes } from 'ethers';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Load your pool artifact (creation bytecode)
const PoolArtifact = require(
  '@lpp/lpp-protocol/artifacts/contracts/LPPPool.sol/LPPPool.json'
);

// INIT_CODE_HASH = keccak256(creation bytecode)
export const POOL_INIT_CODE_HASH = keccak256(getBytes(PoolArtifact.bytecode));

export function computePoolAddress(
  factoryAddress: string,
  [tokenA, tokenB]: [string, string],
  fee: number
): string {
  // sort addresses (same convention as factory)
  const [token0, token1] =
    tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

  // ❗ ABI-ENCODE, not packed
  const salt = keccak256(
    new AbiCoder().encode(['address', 'address', 'uint24'], [token0, token1, fee])
  );

  // CREATE2 hash
  const create2 = keccak256(
    solidityPacked(
      ['bytes1', 'address', 'bytes32', 'bytes32'],
      ['0xff', factoryAddress, salt, POOL_INIT_CODE_HASH]
    )
  );

  return getAddress(`0x${create2.slice(-40)}`);
}