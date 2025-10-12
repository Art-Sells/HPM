// test/shared/computePoolAddress.ts
import { keccak256, getAddress, solidityPacked } from 'ethers';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ✅ Directly load the LPPPool artifact (creation bytecode)
const LPPPoolArtifact = require(
  '@lpp/lpp-protocol/artifacts/contracts/LPPPool.sol/LPPPool.json'
);

// ✅ Hash the creation bytecode (not deployedBytecode)
export const POOL_INIT_CODE_HASH = keccak256(LPPPoolArtifact.bytecode);

export function computePoolAddress(
  factoryAddress: string,
  [tokenA, tokenB]: [string, string],
  fee: number
): string {
  const [token0, token1] =
    tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

  const salt = keccak256(
    solidityPacked(['address', 'address', 'uint24'], [token0, token1, fee])
  );

  const create2 = keccak256(
    solidityPacked(
      ['bytes1', 'address', 'bytes32', 'bytes32'],
      ['0xff', factoryAddress, salt, POOL_INIT_CODE_HASH]
    )
  );

  return getAddress(`0x${create2.slice(-40)}`);
}