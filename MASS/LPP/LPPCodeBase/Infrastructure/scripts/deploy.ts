// scripts/deploy.ts
// Section 2: Deploy & Wire Contracts (On-Chain Only)
// From MCV_Integration_Guide.md
//
// Usage:
//   npx hardhat run scripts/deploy.ts --network base
//
// Environment variables required:
//   - PRIVATE_KEY_DEPLOYER or PRIVATE_KEY: Private key of the deployer account
//   - BASE_RPC_URL (optional): Override Base mainnet RPC URL (default from guide)

import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
dotenv.config();

async function main() {
  const provider = ethers.provider;

  // Load deployer private key from environment
  // Supports both PRIVATE_KEY_DEPLOYER and PRIVATE_KEY for flexibility
  const deployerPk = process.env.PRIVATE_KEY_DEPLOYER || process.env.PRIVATE_KEY;
  if (!deployerPk) {
    throw new Error("Set PRIVATE_KEY_DEPLOYER or PRIVATE_KEY in .env");
  }
  
  // Create signer from private key
  const deployer = new ethers.Wallet(deployerPk, provider);

  console.log("Deploying from:", await deployer.getAddress());
  console.log("Network:", (await provider.getNetwork()).name);
  console.log("Chain ID:", (await provider.getNetwork()).chainId);

  // Addresses from Section 1 of the guide
  const TREASURY_OWNER = "0xd9a6714bba0985b279dfcaff0a512ba25f5a03d1";
  const TREASURY_OPS = "0xd9a6714bba0985b279dfcaff0a512ba25f5a03d1"; // Same address for both
  const ASSET_ADDRESS = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"; // cbBTC
  const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC

  console.log("\n=== Section 2: Deploy & Wire Contracts ===\n");

  // Step 1: Deploy LPPAccessManager
  console.log("1. Deploying LPPAccessManager...");
  const AccessManagerFactory = await ethers.getContractFactory("LPPAccessManager", deployer);
  const accessManager = await AccessManagerFactory.deploy();
  await accessManager.waitForDeployment();
  const accessManagerAddr = await accessManager.getAddress();
  console.log("   ✓ LPPAccessManager deployed at:", accessManagerAddr);

  // Step 2: Deploy LPPTreasury
  console.log("2. Deploying LPPTreasury...");
  const TreasuryFactory = await ethers.getContractFactory("LPPTreasury", deployer);
  const treasury = await TreasuryFactory.deploy();
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();
  console.log("   ✓ LPPTreasury deployed at:", treasuryAddr);

  // Step 3: Deploy LPPFactory (requires treasury address)
  console.log("3. Deploying LPPFactory...");
  const FactoryFactory = await ethers.getContractFactory("LPPFactory", deployer);
  const factory = await FactoryFactory.deploy(treasuryAddr);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("   ✓ LPPFactory deployed at:", factoryAddr);

  // Step 4: Deploy LPPRouter (requires accessManager and treasury)
  console.log("4. Deploying LPPRouter...");
  const RouterFactory = await ethers.getContractFactory("LPPRouter", deployer);
  const router = await RouterFactory.deploy(accessManagerAddr, treasuryAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("   ✓ LPPRouter deployed at:", routerAddr);

  // Step 5: Whitelist treasuryOps via accessManager (before transferring ownership)
  console.log("\n5. Whitelisting treasuryOps...");
  const tx2 = await accessManager.setApprovedSupplicator(TREASURY_OPS, true);
  await tx2.wait();
  console.log("   ✓ treasuryOps whitelisted:", TREASURY_OPS);

  // Step 6: Transfer ownerships to treasuryOwner
  console.log("6. Transferring contract ownerships...");
  const tx1a = await accessManager.transferOwnership(TREASURY_OWNER);
  await tx1a.wait();
  console.log("   ✓ AccessManager ownership transferred to:", TREASURY_OWNER);
  
  const tx1b = await treasury.transferOwnership(TREASURY_OWNER);
  await tx1b.wait();
  console.log("   ✓ Treasury ownership transferred to:", TREASURY_OWNER);

  // Verify the whitelist
  const isApproved = await accessManager.isApprovedSupplicator(TREASURY_OPS);
  console.log("   ✓ Verification - isApproved:", isApproved);

  // Step 7: Record all addresses (deployment manifest)
  console.log("\n=== DEPLOYMENT MANIFEST ===");
  console.log("LPPAccessManager:", accessManagerAddr);
  console.log("LPPTreasury:", treasuryAddr);
  console.log("LPPFactory:", factoryAddr);
  console.log("LPPRouter:", routerAddr);
  console.log("ASSET (cbBTC):", ASSET_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Treasury Owner:", TREASURY_OWNER);
  console.log("Treasury Ops:", TREASURY_OPS);
  console.log("===========================\n");

  // Save to a JSON file for easy reference
  const manifest = {
    network: (await provider.getNetwork()).name,
    chainId: Number((await provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    contracts: {
      LPPAccessManager: accessManagerAddr,
      LPPTreasury: treasuryAddr,
      LPPFactory: factoryAddr,
      LPPRouter: routerAddr,
    },
    tokens: {
      ASSET: ASSET_ADDRESS,
      USDC: USDC_ADDRESS,
    },
    operators: {
      treasuryOwner: TREASURY_OWNER,
      treasuryOps: TREASURY_OPS,
    },
  };

  const manifestPath = path.join(__dirname, "..", "deployment-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log("✓ Deployment manifest saved to:", manifestPath);

  console.log("\n=== Section 2 Complete ===");
  console.log("Next: Proceed to Section 3 (Build the Six-Pool Topology)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
