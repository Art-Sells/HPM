// scripts/typechain.mjs
import fs from "fs";
import path from "path";
import { runTypeChain } from "typechain";

const ROOT = process.cwd();
const ARTIFACTS_DIR = path.join(ROOT, "artifacts", "contracts");

function listAbiArtifacts(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        // Skip build-info entirely
        if (!p.includes("build-info")) stack.push(p);
      } else if (p.endsWith(".json") && !p.endsWith(".dbg.json")) {
        try {
          const j = JSON.parse(fs.readFileSync(p, "utf8"));
          if (Array.isArray(j.abi)) out.push(p);
        } catch (_) {
          // ignore unreadable json
        }
      }
    }
  }
  return out;
}

const files = listAbiArtifacts(ARTIFACTS_DIR);
if (files.length === 0) {
  console.error("No ABI-bearing artifacts found under artifacts/contracts.");
  process.exit(1);
}

console.log(`Found ${files.length} ABI artifacts. Generating types...`);

await runTypeChain({
  cwd: ROOT,
  filesToProcess: files,
  allFiles: files,
  outDir: "typechain-types",
  target: "ethers-v6",
});

console.log("TypeChain generation complete -> typechain-types/");