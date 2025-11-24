// Deep debug: Check router contract on-chain and try to understand the revert
import hre from "hardhat";
const { ethers } = hre;
import * as dotenv from "dotenv";
import * as fs from "fs";
dotenv.config();

async function main() {
  const provider = ethers.provider;
  const deployerPk = process.env.PRIVATE_KEY_DEPLOYER || process.env.PRIVATE_KEY;
  if (!deployerPk) throw new Error("Set PRIVATE_KEY_DEPLOYER or PRIVATE_KEY");
  const deployer = new ethers.Wallet(deployerPk, provider);

  const manifest = JSON.parse(fs.readFileSync("deployment-manifest.json", "utf-8"));
  const routerAddr = manifest.contracts.LPPRouter;
  const treasuryAddr = manifest.contracts.LPPTreasury;

  const pools = [
    "0xb5889070070C9A666bd411E4D882e3E545f74aE0", // Pool0
    "0xa6c62A4edf110703f69505Ea8fAD940aDc6EAF9D", // Pool1
    "0x439634467E0322759b1a7369a552204ea42A3463", // Pool2
    "0xB1a5D1943612BbEE35ee7720f3a4bba74Fdc68b7", // Pool3
  ];

  const negOrbit = [pools[0], pools[1]];
  const posOrbit = [pools[2], pools[3]];

  console.log("=== Deep Router Debug ===\n");

  // 1. Check router contract code
  console.log("1. Checking router contract...");
  const routerCode = await provider.getCode(routerAddr);
  console.log(`   Code length: ${routerCode.length} bytes`);
  console.log(`   Has code: ${routerCode !== "0x" && routerCode !== "0x0"}`);

  // 2. Check router state
  const RouterFactory = await ethers.getContractFactory("LPPRouter");
  const router = RouterFactory.attach(routerAddr).connect(provider);
  
  console.log("\n2. Checking router state...");
  try {
    const routerTreasury = await router.treasury();
    console.log(`   Treasury: ${routerTreasury}`);
    console.log(`   Matches our treasury: ${routerTreasury.toLowerCase() === treasuryAddr.toLowerCase()}`);
    
    const isPaused = await router.paused();
    console.log(`   Paused: ${isPaused}`);
  } catch (error: any) {
    console.log(`   ❌ Error reading router state: ${error.message}`);
  }

  // 3. Try to call setDualOrbit directly on router (should fail with "not treasury")
  console.log("\n3. Testing direct router call (should fail with 'not treasury')...");
  try {
    await router.setDualOrbit(pools[0], negOrbit, posOrbit, true);
    console.log("   ⚠ Unexpected: Direct call succeeded!");
  } catch (error: any) {
    console.log(`   Expected failure: ${error.message}`);
    if (error.reason) console.log(`   Reason: ${error.reason}`);
    if (error.data) {
      console.log(`   Error data: ${error.data}`);
      // Try to decode
      try {
        const decoded = router.interface.parseError(error.data);
        if (decoded) {
          console.log(`   Decoded: ${decoded.name}(${JSON.stringify(decoded.args)})`);
        }
      } catch {
        // Try Error(string)
        if (error.data.toString().startsWith("0x08c379a0")) {
          try {
            const abiCoder = new ethers.AbiCoder();
            const decoded = abiCoder.decode(["string"], "0x" + error.data.toString().slice(10));
            console.log(`   Error string: "${decoded[0]}"`);
          } catch {}
        }
      }
    }
  }

  // 4. Try through treasury
  console.log("\n4. Testing through treasury...");
  const TreasuryFactory = await ethers.getContractFactory("LPPTreasury");
  const treasury = TreasuryFactory.attach(treasuryAddr).connect(deployer);

  // 4a. Check treasury owner
  const treasuryOwner = await treasury.owner();
  const deployerAddr = await deployer.getAddress();
  console.log(`   Treasury owner: ${treasuryOwner}`);
  console.log(`   Deployer: ${deployerAddr}`);
  console.log(`   Match: ${treasuryOwner.toLowerCase() === deployerAddr.toLowerCase()}`);

  // 4b. Try to manually construct the call data and use eth_call
  console.log("\n5. Manually constructing call data for eth_call...");
  const callData = treasury.interface.encodeFunctionData("setDualOrbitViaTreasury", [
    routerAddr,
    pools[0],
    negOrbit,
    posOrbit,
    true
  ]);
  console.log(`   Call data length: ${callData.length} bytes`);
  console.log(`   Call data: ${callData.slice(0, 100)}...`);

  // Try eth_call directly
  try {
    const result = await provider.call({
      to: treasuryAddr,
      data: callData,
      from: deployerAddr,
    });
    console.log(`   ✓ eth_call succeeded: ${result}`);
  } catch (error: any) {
    console.log(`   ❌ eth_call failed: ${error.message}`);
    if (error.data) {
      console.log(`   Error data: ${error.data}`);
      // Try to decode
      try {
        const decoded = router.interface.parseError(error.data);
        if (decoded) {
          console.log(`   Decoded router error: ${decoded.name}(${JSON.stringify(decoded.args)})`);
        }
      } catch {
        try {
          const decoded = treasury.interface.parseError(error.data);
          if (decoded) {
            console.log(`   Decoded treasury error: ${decoded.name}(${JSON.stringify(decoded.args)})`);
          }
        } catch {
          // Try Error(string)
          if (error.data && error.data.toString().startsWith("0x08c379a0")) {
          try {
            const abiCoder = new ethers.AbiCoder();
            const decoded = abiCoder.decode(["string"], "0x" + error.data.toString().slice(10));
            console.log(`   Error string: "${decoded[0]}"`);
          } catch {}
        }
        }
      }
    }
  }

  // 6. Check if orbits are already set
  console.log("\n6. Checking if orbits are already set...");
  for (let i = 0; i < 4; i++) {
    try {
      const dualOrbit = await router.getDualOrbit(pools[i]);
      console.log(`   Pool${i}: Orbit exists - neg.length=${dualOrbit[0].length}, pos.length=${dualOrbit[1].length}`);
    } catch (error: any) {
      if (error.message.includes("dual: not set")) {
        console.log(`   Pool${i}: Orbit not set ✓`);
      } else {
        console.log(`   Pool${i}: Error - ${error.message}`);
      }
    }
  }

  // 7. Verify pool interface compatibility
  console.log("\n7. Verifying pool interface compatibility...");
  const PoolFactory = await ethers.getContractFactory("LPPPool");
  for (let i = 0; i < 4; i++) {
    const pool = PoolFactory.attach(pools[i]).connect(provider);
    try {
      // Check if pool implements the interface correctly
      const asset = await pool.asset();
      const usdc = await pool.usdc();
      const code = await provider.getCode(pools[i]);
      console.log(`   Pool${i}: asset=${asset}, usdc=${usdc}, code=${code.length} bytes ✓`);
    } catch (error: any) {
      console.log(`   Pool${i}: ❌ Interface error - ${error.message}`);
    }
  }
}

main().catch(console.error);

