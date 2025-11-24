// Check what functions are actually in the deployed router
import hre from "hardhat";
const { ethers } = hre;
import * as dotenv from "dotenv";
import * as fs from "fs";
dotenv.config();

async function main() {
  const provider = ethers.provider;
  const manifest = JSON.parse(fs.readFileSync("deployment-manifest.json", "utf-8"));
  const routerAddr = manifest.contracts.LPPRouter;

  console.log("=== Checking Deployed Router Functions ===\n");

  const RouterFactory = await ethers.getContractFactory("LPPRouter");
  const router = RouterFactory.attach(routerAddr).connect(provider);

  // Get all function selectors from our interface
  const iface = RouterFactory.interface;
  const allFunctions = Object.keys(iface.functions);
  
  console.log("Expected functions in interface:");
  allFunctions.forEach((func) => {
    const selector = iface.getFunction(func).selector;
    console.log(`  ${func} -> ${selector}`);
  });

  // Get deployed bytecode
  const deployedCode = await provider.getCode(routerAddr);
  console.log(`\nDeployed bytecode length: ${deployedCode.length} bytes`);

  // Check which selectors exist in deployed code
  console.log("\nChecking which selectors exist in deployed code:");
  const missingFunctions: string[] = [];
  const foundFunctions: string[] = [];
  
  for (const func of allFunctions) {
    const selector = iface.getFunction(func).selector;
    const selectorHex = selector.slice(2); // Remove 0x
    const exists = deployedCode.toLowerCase().includes(selectorHex.toLowerCase());
    
    if (exists) {
      foundFunctions.push(func);
      console.log(`  ✓ ${func} (${selector})`);
    } else {
      missingFunctions.push(func);
      console.log(`  ❌ ${func} (${selector}) - NOT FOUND`);
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Found: ${foundFunctions.length}/${allFunctions.length}`);
  console.log(`  Missing: ${missingFunctions.length}/${allFunctions.length}`);
  
  if (missingFunctions.length > 0) {
    console.log(`\n⚠ MISSING FUNCTIONS:`);
    missingFunctions.forEach((f) => console.log(`  - ${f}`));
    console.log(`\n⚠ The deployed router contract is missing these functions!`);
    console.log(`⚠ This suggests the router was deployed with an older version of the code.`);
    console.log(`⚠ You may need to redeploy the router with the current code.`);
  }

  // Try to call a function that should exist
  console.log(`\nTesting if basic functions work:`);
  try {
    const treasury = await router.treasury();
    console.log(`  ✓ router.treasury() works: ${treasury}`);
  } catch (e: any) {
    console.log(`  ❌ router.treasury() failed: ${e.message}`);
  }

  try {
    const paused = await router.paused();
    console.log(`  ✓ router.paused() works: ${paused}`);
  } catch (e: any) {
    console.log(`  ❌ router.paused() failed: ${e.message}`);
  }
}

main().catch(console.error);

