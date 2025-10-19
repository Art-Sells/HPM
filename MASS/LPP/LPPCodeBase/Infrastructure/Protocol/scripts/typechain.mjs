// scripts/typechain.mjs
import fs from "fs";
import path from "path";
import { runTypeChain } from "typechain";

const ROOT = process.cwd();
const PERIPHERY_ARTS = path.join(ROOT, "../Periphery", "artifacts", "contracts");
const PROTOCOL_ARTS  = path.resolve(ROOT, "artifacts", "contracts");

function listAbiArtifacts(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        if (!p.includes("build-info")) stack.push(p);
      } else if (p.endsWith(".json") && !p.endsWith(".dbg.json")) {
        try {
          const j = JSON.parse(fs.readFileSync(p, "utf8"));
          if (Array.isArray(j.abi)) out.push(p);
        } catch { /* ignore */ }
      }
    }
  }
  return out;
}

const peripheryFiles = listAbiArtifacts(PERIPHERY_ARTS);
const protocolFiles  = listAbiArtifacts(PROTOCOL_ARTS);
console.log("DEBUG: Searching for protocol artifacts in:", PROTOCOL_ARTS);
console.log("DEBUG: Found these files:", protocolFiles);

if (!peripheryFiles.length && !protocolFiles.length) {
  console.error("No ABI-bearing artifacts found in Periphery or Protocol.");
  process.exit(1);
}

if (peripheryFiles.length) {
  console.log(`Periphery: ${peripheryFiles.length} ABI files -> typechain-types/periphery`);
  await runTypeChain({
    cwd: ROOT,
    filesToProcess: peripheryFiles,
    allFiles: peripheryFiles,
    outDir: "typechain-types/periphery",
    target: "ethers-v6",
  });
}

if (protocolFiles.length) {
  console.log(`Protocol: ${protocolFiles.length} ABI files -> typechain-types/protocol`);
  await runTypeChain({
    cwd: ROOT,
    filesToProcess: protocolFiles,
    allFiles: protocolFiles,
    outDir: "typechain-types/protocol",
    target: "ethers-v6",
  });
}

console.log("TypeChain generation complete.");