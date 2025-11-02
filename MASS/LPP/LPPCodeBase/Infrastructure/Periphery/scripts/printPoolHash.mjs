// scripts/printPoolHash.mjs
import { createRequire } from 'module'
import { keccak256, getBytes } from 'ethers'
const require = createRequire(import.meta.url)

const { bytecode } = require('@lpp/lpp-protocol/artifacts/contracts/LPPPool.sol/LPPPool.json')
console.log(keccak256(getBytes(bytecode)))