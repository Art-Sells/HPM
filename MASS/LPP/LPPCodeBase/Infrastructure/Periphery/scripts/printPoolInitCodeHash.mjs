// ESM, Node 18+
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { keccak256, getBytes } from 'ethers'

const require = createRequire(import.meta.url)

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name)
    return d.isDirectory() ? walk(p) : [p]
  })
}

function tryResolvePkgRoot(pkg) {
  try { return path.dirname(require.resolve(`${pkg}/package.json`)) } catch { return null }
}
function dirIfExists(p) {
  try { return p && fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null } catch { return null }
}

// Candidate roots (package first, then workspace fallbacks)
const candidates = []
const pkgRoot = tryResolvePkgRoot('@lpp/lpp-protocol')
if (pkgRoot) {
  const p = dirIfExists(path.join(pkgRoot, 'artifacts', 'contracts'))
  if (p) candidates.push(p)
}
;[
  path.resolve(process.cwd(), '../Protocol/artifacts/contracts'),
  path.resolve(process.cwd(), '../protocol/artifacts/contracts'),
  path.resolve(process.cwd(), '../../Protocol/artifacts/contracts'),
  path.resolve(process.cwd(), '../../protocol/artifacts/contracts'),
].forEach(p => { const ok = dirIfExists(p); if (ok) candidates.push(ok) })

if (candidates.length === 0) {
  console.error('❌ No artifacts found.\nTried package and workspace paths.')
  console.error('Fix:\n  1) Ensure Protocol compiled:  yarn --cwd ../Protocol hardhat compile')
  console.error('  2) Confirm artifacts exist:   ls ../Protocol/artifacts/contracts')
  process.exit(1)
}

// Find a concrete Pool implementation with bytecode
let chosen = null
for (const root of candidates) {
  const files = walk(root).filter(f => f.endsWith('.json'))
  for (const f of files) {
    let j
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
    const name = (j.contractName || path.basename(f, '.json')).toLowerCase()
    const abi = j.abi || []
    const hasBytecode = j.bytecode && j.bytecode !== '0x'
    const looksLikePool =
      name.includes('pool') &&
      abi.some(x => x.type === 'function' && x.name === 'initialize') &&
      abi.some(x => x.type === 'function' && x.name === 'slot0')
    if (hasBytecode && looksLikePool) { chosen = { file: f, json: j }; break }
  }
  if (chosen) break
}

if (!chosen) {
  console.error('❌ Could not find a pool implementation artifact in:')
  candidates.forEach(c => console.error('  -', c))
  process.exit(1)
}

// Compute INIT_CODE_HASH from creation bytecode (NOT runtimeCode)
const bytecode = chosen.json.bytecode
const hash = keccak256(getBytes(bytecode))

console.log('Artifact :', chosen.file)
console.log('POOL_INIT_CODE_HASH:', hash)