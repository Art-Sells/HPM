// test/shared/computePoolAddress.ts
import { keccak256, getAddress, AbiCoder } from 'ethers';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// IMPORTANT: we’re not using uniswap; this points at your LPP artifact
const LPPPoolArtifact: { bytecode: `0x${string}` } = require(
  '@lpp/lpp-protocol/artifacts/contracts/LPPPool.sol/LPPPool.json'
);

export const POOL_BYTECODE_HASH = keccak256(LPPPoolArtifact.bytecode);

export function computePoolAddress(
  factoryAddress: string,
  [tokenA, tokenB]: [string, string],
  fee: number // uint24 on-chain
): string {
  const [token0, token1] =
    tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

  const abiCoder = new AbiCoder();
  // salt = keccak256(abi.encode(token0, token1, fee))
  const salt = keccak256(
    abiCoder.encode(['address', 'address', 'uint24'], [token0, token1, fee])
  );

  // CREATE2: keccak256(0xff ++ factory ++ salt ++ keccak256(init_code)))[12:]
  const create2Inputs = [
    '0xff',
    factoryAddress,
    salt,
    POOL_BYTECODE_HASH, // init code hash = keccak256(creation bytecode)
  ];

  const sanitizedInputs = `0x${create2Inputs.map((i) => i.slice(2)).join('')}`;
  return getAddress(`0x${keccak256(sanitizedInputs).slice(-40)}`);
}