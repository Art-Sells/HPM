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

import hre from "hardhat";
const { ethers } = hre;
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
dotenv.config();

const ts = () => new Date().toISOString();

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

  console.log(`[${ts()}] Starting deployment script...`);
  const signerAddr = await deployer.getAddress();
  console.log(`[${ts()}] Deploying from: ${signerAddr}`);
  const network = await provider.getNetwork();
  console.log(`[${ts()}] Network: ${network.name} (chainId=${network.chainId})`);

  // Addresses from Section 1 of the guide
  const TREASURY_OWNER = "0xd9a6714bba0985b279dfcaff0a512ba25f5a03d1";
  const TREASURY_OPS = "0xd9a6714bba0985b279dfcaff0a512ba25f5a03d1"; // Same address for both
  const ASSET_ADDRESS = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"; // cbBTC
  const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC

  console.log(`\n=== Section 2: Deploy & Wire Contracts === (${ts()})\n`);

  // Step 1: Deploy FAFEAccessManager
  console.log(`[${ts()}] 1. Deploying FAFEAccessManager...`);
  const AccessManagerFactory = await ethers.getContractFactory("FAFEAccessManager", deployer);
  const accessManager = await AccessManagerFactory.deploy();
  await accessManager.waitForDeployment();
  const accessManagerAddr = await accessManager.getAddress();
  console.log(`[${ts()}]    ✓ FAFEAccessManager deployed at: ${accessManagerAddr}`);

  // Step 2: Deploy FAFETreasury
  console.log(`[${ts()}] 2. Deploying FAFETreasury...`);
  const TreasuryFactory = await ethers.getContractFactory("FAFETreasury", deployer);
  const treasury = await TreasuryFactory.deploy();
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();
  console.log(`[${ts()}]    ✓ FAFETreasury deployed at: ${treasuryAddr}`);

  // Step 2a: Set treasury on AccessManager (required for setDedicatedAA)
  console.log(`[${ts()}] 2a. Setting treasury on AccessManager...`);
  const tx2a = await accessManager.setTreasury(treasuryAddr);
  console.log(`[${ts()}]    ↳ tx hash: ${tx2a.hash}`);
  await tx2a.wait();
  console.log(`[${ts()}]    ✓ Treasury set on AccessManager`);

  // Step 3: Deploy FAFEFactory (requires treasury address)
  console.log(`[${ts()}] 3. Deploying FAFEFactory...`);
  const FactoryFactory = await ethers.getContractFactory("FAFEFactory", deployer);
  const factory = await FactoryFactory.deploy(treasuryAddr);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`[${ts()}]    ✓ FAFEFactory deployed at: ${factoryAddr}`);

  // Step 4: Deploy FAFERouter (requires accessManager and treasury)
  console.log(`[${ts()}] 4. Deploying FAFERouter...`);
  const RouterFactory = await ethers.getContractFactory("FAFERouter", deployer);
  const router = await RouterFactory.deploy(accessManagerAddr, treasuryAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log(`[${ts()}]    ✓ FAFERouter deployed at: ${routerAddr}`);

  // Step 5: Whitelist treasuryOps via accessManager (before transferring ownership)
  console.log(`\n[${ts()}] 5. Whitelisting treasuryOps...`);
  const tx2 = await accessManager.setApprovedSupplicator(TREASURY_OPS, true);
  console.log(`[${ts()}]    ↳ tx hash: ${tx2.hash} (waiting for confirmation)`);
  await tx2.wait();
  console.log(`[${ts()}]    ✓ treasuryOps whitelisted: ${TREASURY_OPS}`);

  // Step 6: Transfer ownerships to treasuryOwner
  console.log(`[${ts()}] 6. Transferring contract ownerships...`);
  const tx1a = await accessManager.transferOwnership(TREASURY_OWNER);
  console.log(`[${ts()}]    ↳ AccessManager ownership tx: ${tx1a.hash}`);
  await tx1a.wait();
  console.log(`[${ts()}]    ✓ AccessManager ownership transferred to: ${TREASURY_OWNER}`);
  
  const tx1b = await treasury.transferOwnership(TREASURY_OWNER);
  console.log(`[${ts()}]    ↳ Treasury ownership tx: ${tx1b.hash}`);
  await tx1b.wait();
  console.log(`[${ts()}]    ✓ Treasury ownership transferred to: ${TREASURY_OWNER}`);

  // Verify the whitelist
  const isApproved = await accessManager.isApprovedSupplicator(TREASURY_OPS);
  console.log(`[${ts()}]    ✓ Verification - isApproved: ${isApproved}`);

  // Step 7: Record all addresses (deployment manifest)
  console.log(`\n=== DEPLOYMENT MANIFEST (${ts()}) ===`);
  console.log("FAFEAccessManager:", accessManagerAddr);
  console.log("FAFETreasury:", treasuryAddr);
  console.log("FAFEFactory:", factoryAddr);
  console.log("FAFERouter:", routerAddr);
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
      FAFEAccessManager: accessManagerAddr,
      FAFETreasury: treasuryAddr,
      FAFEFactory: factoryAddr,
      FAFERouter: routerAddr,
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

  // Use process.cwd() to get the project root directory
  const manifestPath = path.join(process.cwd(), "test/Deployment/deployment-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[${ts()}] ✓ Deployment manifest saved to: ${manifestPath}`);

  console.log(`\n=== Section 2 Complete (${ts()}) ===`);
  console.log("Next: Proceed to Section 3 (Build the Six-Pool Topology)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
