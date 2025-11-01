// Periphery/scripts/print-init-code-hash.mjs
// ESM, Node 18+
// Prints the INIT_CODE_HASH by hashing the *creation* bytecode of LPPPool
// Prefers workspace artifacts over node_modules to avoid stale hashes.

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { keccak256, getBytes } from 'ethers'

const require = createRequire(import.meta.url)

function dirIfExists(p) {
  try {
    return p && fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null
  } catch {
    return null
  }
}

function tryResolvePkgRoot(pkg) {
  try {
    return path.dirname(require.resolve(`${pkg}/package.json`))
  } catch {
    return null
  }
}

// 1) Build candidate artifact roots — WORKSPACE FIRST, then node_modules
const candidates = [
  // common monorepo layouts
  path.resolve(process.cwd(), '../Protocol/artifacts/contracts'),
  path.resolve(process.cwd(), '../../Protocol/artifacts/contracts'),
  path.resolve(process.cwd(), '../protocol/artifacts/contracts'),
  path.resolve(process.cwd(), '../../protocol/artifacts/contracts'),
].map(dirIfExists).filter(Boolean)

const pkgRoot = tryResolvePkgRoot('@lpp/lpp-protocol')
if (pkgRoot) {
  const p = dirIfExists(path.join(pkgRoot, 'artifacts', 'contracts'))
  if (p) candidates.push(p) // node_modules LAST (stale-safe)
}

if (candidates.length === 0) {
  console.error('❌ No artifact roots found.\nLooked for ../Protocol/**/artifacts/contracts and @lpp/lpp-protocol.')
  console.error('Fix:\n  yarn --cwd ../Protocol hardhat compile\n  ls ../Protocol/artifacts/contracts')
  process.exit(1)
}

// 2) Try exact known relative paths first (adjust if your layout differs)
const poolRelPaths = [
  'pool/LPPPool.sol/LPPPool.json',
  'Pool/LPPPool.sol/LPPPool.json',
  'core/LPPPool.sol/LPPPool.json',
  'protocol/pool/LPPPool.sol/LPPPool.json',
]

// 3) Helper to read a JSON file
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

// 4) Try to find the exact LPPPool artifact
let chosen = null
for (const root of candidates) {
  for (const rel of poolRelPaths) {
    const full = path.join(root, rel)
    if (fs.existsSync(full)) {
      const j = readJson(full)
      if (j?.bytecode && j.bytecode !== '0x') {
        chosen = { file: full, json: j }
        break
      }
    }
  }
  if (chosen) break
}

// 5) Fallback: scan for contractName === 'LPPPool' if exact paths failed
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name)
    return d.isDirectory() ? walk(p) : [p]
  })
}

if (!chosen) {
  for (const root of candidates) {
    const files = walk(root).filter(f => f.endsWith('.json'))
    for (const f of files) {
      const j = readJson(f)
      if (!j) continue
      const contractName = j.contractName || j.contract || ''
      const sourceName = j.sourceName || ''
      const isPool =
        contractName === 'LPPPool' ||
        /(?:^|\/)LPPPool\.sol$/.test(sourceName)
      if (isPool && j.bytecode && j.bytecode !== '0x') {
        chosen = { file: f, json: j }
        break
      }
    }
    if (chosen) break
  }
}

if (!chosen) {
  console.error('❌ Could not find LPPPool artifact JSON with creation bytecode in any of:')
  candidates.forEach(c => console.error('  -', c))
  console.error('\nMake sure Protocol compiled and that the artifact path matches pool/LPPPool.sol/LPPPool.json.')
  process.exit(1)
}

// 6) Compute INIT_CODE_HASH from *creation* bytecode
const bytecode = chosen.json.bytecode
const hash = keccak256(getBytes(bytecode))

console.log('Artifact :', chosen.file)
console.log('POOL_INIT_CODE_HASH:', hash)