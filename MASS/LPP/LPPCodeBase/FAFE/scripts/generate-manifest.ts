// scripts/generate-manifest.ts
// Generate deployment manifest from already-deployed addresses

import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";
import * as path from "path";

async function main() {
  // Addresses from the successful deployment
  const addresses = {
    FAFEAccessManager: "0x0729435C4281f03b5b8095Ec2371A009814Ce45d",
    FAFETreasury: "0x259c964e22C687dC9746A486a206FA48e8288D4C",
    FAFEFactory: "0x1b6Ce8517065b3695d15aBde67517bac677939BF",
    FAFERouter: "0xD380A0ea6cE68ffBC577248ea0Eb707af55b8572",
  };

  // Addresses from Section 1 of the guide
  const TREASURY_OWNER = "0xd9a6714bba0985b279dfcaff0a512ba25f5a03d1";
  const TREASURY_OPS = "0xd9a6714bba0985b279dfcaff0a512ba25f5a03d1";
  const ASSET_ADDRESS = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"; // cbBTC
  const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC

  const manifest = {
    network: (await ethers.provider.getNetwork()).name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    contracts: addresses,
    tokens: {
      ASSET: ASSET_ADDRESS,
      USDC: USDC_ADDRESS,
    },
    operators: {
      treasuryOwner: TREASURY_OWNER,
      treasuryOps: TREASURY_OPS,
    },
  };

  const manifestPath = path.join(process.cwd(), "test/Deployment/deployment-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log("✓ Deployment manifest saved to:", manifestPath);
  console.log("\n=== DEPLOYMENT MANIFEST ===");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

