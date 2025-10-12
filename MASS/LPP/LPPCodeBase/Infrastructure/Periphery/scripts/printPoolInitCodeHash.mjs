// Periphery/scripts/printPoolInitCodeHash.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { keccak256, getBytes } from 'ethers'

const require = createRequire(import.meta.url)

// 1) Find the protocol package root on disk
const pkgJsonPath = require.resolve('@lpp/lpp-protocol/package.json')
const pkgRoot = path.dirname(pkgJsonPath)
const artifactsDir = path.join(pkgRoot, 'artifacts', 'contracts')

// 2) Walk the artifacts tree to find a concrete Pool implementation (not an interface)
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name)
    return d.isDirectory() ? walk(p) : [p]
  })
}
const files = walk(artifactsDir).filter(f => f.endsWith('.json'))

let chosen = null
for (const f of files) {
  let j
  try {
    j = JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch { continue }

  const name = (j.contractName || path.basename(f, '.json')).toLowerCase()
  const abi = j.abi || []
  const hasBytecode = j.bytecode && j.bytecode !== '0x'
  const looksLikePool =
    name.includes('pool') &&
    abi.some(x => x.type === 'function' && x.name === 'initialize') &&
    abi.some(x => x.type === 'function' && x.name === 'slot0')

  if (hasBytecode && looksLikePool) {
    chosen = { file: f, json: j }
    break
  }
}

if (!chosen) {
  console.error('❌ Could not find a pool implementation artifact in @lpp/lpp-protocol/artifacts/contracts/**')
  process.exit(1)
}

// 3) Compute the INIT_CODE_HASH from the creation bytecode
const bytecode = chosen.json.bytecode
const hash = keccak256(getBytes(bytecode))

console.log('Artifact:', path.relative(pkgRoot, chosen.file))
console.log('POOL_INIT_CODE_HASH:', hash)
