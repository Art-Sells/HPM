import hre from "hardhat";
const { ethers } = hre;

async function main() {
  const provider = ethers.provider;
  const routerAddr = "0x44EF6fcbfb077752a50b9f1B3F666936484ef4a7";
  const RouterFactory = await ethers.getContractFactory("LPPRouter");
  const router = RouterFactory.attach(routerAddr).connect(provider);

  const pools = [
    "0xb5889070070C9A666bd411E4D882e3E545f74aE0",
    "0xa6c62A4edf110703f69505Ea8fAD940aDc6EAF9D",
    "0x439634467E0322759b1a7369a552204ea42A3463",
    "0xB1a5D1943612BbEE35ee7720f3a4bba74Fdc68b7"
  ];

  console.log("=== EXPLANATION ===");
  console.log("pool-manifest.json is a LOCAL FILE we created to track deployments.");
  console.log("It's NOT on-chain data - the router contract doesn't read it.");
  console.log("The router only knows about orbits registered via setDualOrbit() transactions.\n");
  
  console.log("Checking what the router ACTUALLY knows on-chain...\n");
  let allRegistered = true;
  for (let i = 0; i < 4; i++) {
    try {
      const dualOrbit = await router.getDualOrbit(pools[i]);
      console.log(`Pool${i} (${pools[i]}):`);
      console.log(`  NEG orbit: ${dualOrbit[0].length} pools - ${dualOrbit[0].join(", ")}`);
      console.log(`  POS orbit: ${dualOrbit[1].length} pools - ${dualOrbit[1].join(", ")}`);
      console.log(`  Initialized: ${dualOrbit[2]}`);
      if (!dualOrbit[2]) {
        allRegistered = false;
      }
      console.log("");
    } catch (e: any) {
      console.log(`Pool${i} (${pools[i]}): NOT REGISTERED ON-CHAIN`);
      console.log(`  Error: ${e.message}`);
      console.log(`  The pool exists and has funds, but the router doesn't know about its orbit yet.\n`);
      allRegistered = false;
    }
  }
  
  console.log("=== SUMMARY ===");
  if (allRegistered) {
    console.log("✓ All orbits are registered ON-CHAIN! The router is ready for swaps.");
  } else {
    console.log("⚠ Orbits are NOT registered ON-CHAIN in the router contract.");
    console.log("⚠ pool-manifest.json shows our INTENT, but we need to call setDualOrbit()");
    console.log("⚠ to register them on-chain so searchers can use them.");
    console.log("\nThis is what section3-build-topology.ts is trying to do, but it's failing");
    console.log("due to gas price issues with the RPC node.");
  }
}

main().catch(console.error);

