// Periphery/test/NonfungiblePoolAddress.hash.spec.ts
import { createRequire } from 'module'
import fs from 'node:fs'
import path from 'node:path'
import hre from 'hardhat'
import { keccak256, getBytes } from 'ethers'
import { expect } from './shared/expect.ts'
import { getInitHash } from './shared/poolAddressLib.ts'

const { ethers } = hre
const require = createRequire(import.meta.url)

function resolveLPPPoolArtifactPath(): string {
  // Always use the package artifact that the constant was derived from
  return require.resolve(
    '@lpp/lpp-protocol/artifacts/contracts/LPPPool.sol/LPPPool.json'
  );
}

describe('PoolAddress sanity', () => {
  it('POOL_INIT_CODE_HASH matches pool creation bytecode', async () => {
    const libHash = await getInitHash() // from PoolAddressTest
    const file = resolveLPPPoolArtifactPath()

    const json = JSON.parse(fs.readFileSync(file, 'utf8'))

    // Ask Hardhat/Ethers to build a factory from this artifact so the bytecode is normalized/linked
    const Factory = await ethers.getContractFactoryFromArtifact(json as any)
    const creation = Factory.bytecode
    const artifactHash = keccak256(getBytes(creation))

    console.log('Using LPPPool artifact at:', file)
    const md = json.metadata ? JSON.parse(json.metadata) : null
    console.log('solc:', md?.compiler?.version, 'optimizer runs:', md?.settings?.optimizer?.runs)
    console.log('artifactHash:', artifactHash, 'libHash:', libHash)

    expect(artifactHash).to.eq(libHash)
  })
})