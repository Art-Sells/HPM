// Periphery/test/PoolAddress.hash.spec.ts
import { createRequire } from 'module'
import fs from 'node:fs'
import path from 'node:path'
import { keccak256, getBytes } from 'ethers'
import { expect } from './shared/expect.ts'
import { getInitHash } from './shared/poolAddressLib.ts' // your helper that calls PoolAddressTest.POOL_INIT_CODE_HASH()

const require = createRequire(import.meta.url)

function tryResolve(p: string) { try { return require.resolve(p) } catch { return null } }
function pkgRoot(name: string) {
  const pkg = tryResolve(`${name}/package.json`)
  return pkg ? path.dirname(pkg) : null
}
function dirExists(p?: string | null) {
  try {
    return p && fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null
  } catch { return null }
}

function findPoolArtifact(): { file: string; json: any } {
  const roots: string[] = []

  // 1) Prefer workspace package if present
  const pr = pkgRoot('@lpp/lpp-protocol')
  if (pr) {
    const artifacts = dirExists(path.join(pr, 'artifacts', 'contracts'))
    if (artifacts) roots.push(artifacts)
  }

  // 2) Fallbacks to typical workspace layouts
  ;[
    path.resolve(process.cwd(), '../Protocol/artifacts/contracts'),
    path.resolve(process.cwd(), '../../Protocol/artifacts/contracts'),
    path.resolve(process.cwd(), '../protocol/artifacts/contracts'),
    path.resolve(process.cwd(), '../../protocol/artifacts/contracts'),
  ].forEach(p => { const ok = dirExists(p); if (ok) roots.push(ok) })

  // Walk and pick the concrete pool (must have bytecode + initialize() + slot0())
  for (const root of roots) {
    const stack = fs.readdirSync(root, { withFileTypes: true }).map(d => path.join(root, d.name))
    while (stack.length) {
      const f = stack.pop()!
      const st = fs.statSync(f)
      if (st.isDirectory()) {
        fs.readdirSync(f, { withFileTypes: true }).forEach(d => stack.push(path.join(f, d.name)))
        continue
      }
      if (!f.endsWith('.json')) continue
      let j: any
      try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
      const abi = j.abi || []
      const name = (j.contractName || path.basename(f, '.json')).toLowerCase()
      const hasBytecode = j.bytecode && j.bytecode !== '0x'
      const looksLikePool =
        name.includes('pool') &&
        abi.some((x: any) => x.type === 'function' && x.name === 'initialize') &&
        abi.some((x: any) => x.type === 'function' && x.name === 'slot0')

      if (hasBytecode && looksLikePool) return { file: f, json: j }
    }
  }

  throw new Error('No concrete pool artifact found. Compile Protocol first.')
}

describe('PoolAddress sanity', () => {
  it('POOL_INIT_CODE_HASH matches pool creation bytecode', async () => {
    const libHash = await getInitHash() // from PoolAddressTest (library constant)
    const { file, json } = findPoolArtifact()
    const artifactHash = keccak256(getBytes(json.bytecode))
    // Useful debug when it fails
    // console.log('Artifact:', file, '\nlibHash:', libHash, '\nartifactHash:', artifactHash)
    expect(artifactHash).to.eq(libHash)
  })
})