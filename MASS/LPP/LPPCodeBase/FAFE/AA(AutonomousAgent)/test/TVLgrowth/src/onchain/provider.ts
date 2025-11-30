import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";

let provider: ethers.JsonRpcProvider | null = null;

const RPC_ENV_KEYS = ["BASE_INFURA_RPC", "BASE_RPC", "BASE_ALCHEMY_RPC"];
let envLoaded = false;

function loadEnvFile() {
  if (envLoaded) return;
  envLoaded = true;
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const data = fs.readFileSync(envPath, "utf8");
  data.split(/\r?\n/).forEach((line) => {
    if (!line || line.startsWith("#")) return;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) return;
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    if (!key || value === undefined) return;
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  });
}

function resolveRpcUrl(): string | null {
  loadEnvFile();
  for (const key of RPC_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function getBaseProvider(): ethers.JsonRpcProvider | null {
  if (provider) return provider;
  const url = resolveRpcUrl();
  if (!url) {
    console.warn(
      `[onchain] Missing Base RPC URL. Set one of: ${RPC_ENV_KEYS.join(", ")}`
    );
    return null;
  }
  provider = new ethers.JsonRpcProvider(url);
  return provider;
}

