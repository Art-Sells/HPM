// Direct test of setDualOrbit to get exact revert reason
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

  // Load addresses
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

  const RouterFactory = await ethers.getContractFactory("LPPRouter");
  const router = RouterFactory.attach(routerAddr).connect(deployer);

  // Check router treasury
  const routerTreasury = await router.treasury();
  console.log(`Router treasury: ${routerTreasury}`);
  console.log(`Our treasury: ${treasuryAddr}`);
  console.log(`Match: ${routerTreasury.toLowerCase() === treasuryAddr.toLowerCase()}`);

  // Try calling router directly (this will fail with "not treasury" but let's see)
  console.log("\n1. Testing direct call to router (should fail with 'not treasury')...");
  try {
    await router.setDualOrbit(pools[0], negOrbit, posOrbit, true);
    console.log("   ✓ Direct call succeeded (unexpected!)");
  } catch (error: any) {
    console.log(`   ❌ Direct call failed: ${error.message}`);
    if (error.reason) console.log(`   Revert reason: ${error.reason}`);
    if (error.data) {
      console.log(`   Error data: ${error.data}`);
      // Try to decode
      try {
        const decoded = router.interface.parseError(error.data);
        console.log(`   Decoded: ${decoded.name}(${JSON.stringify(decoded.args)})`);
      } catch {
        // Try Error(string)
        if (error.data.toString().startsWith("0x08c379a0")) {
          try {
            const abiCoder = new ethers.AbiCoder();
            const decoded = abiCoder.decode(["string"], "0x" + error.data.toString().slice(10));
            console.log(`   Error string: ${decoded[0]}`);
          } catch {}
        }
      }
    }
  }

  // Try through treasury
  console.log("\n2. Testing through treasury...");
  const TreasuryFactory = await ethers.getContractFactory("LPPTreasury");
  const treasury = TreasuryFactory.attach(treasuryAddr).connect(deployer);

  try {
    // First try static call
    console.log("   Attempting static call...");
    const result = await treasury.setDualOrbitViaTreasury.staticCall(
      routerAddr,
      pools[0],
      negOrbit,
      posOrbit,
      true
    );
    console.log(`   ✓ Static call succeeded: ${result}`);
  } catch (error: any) {
    console.log(`   ❌ Static call failed: ${error.message}`);
    if (error.reason) console.log(`   Revert reason: ${error.reason}`);
    if (error.data) {
      console.log(`   Error data: ${error.data}`);
      // Try to decode router errors
      try {
        const decoded = router.interface.parseError(error.data);
        console.log(`   Decoded router error: ${decoded.name}(${JSON.stringify(decoded.args)})`);
      } catch {
        // Try Error(string)
        if (error.data.toString().startsWith("0x08c379a0")) {
          try {
            const abiCoder = new ethers.AbiCoder();
            const decoded = abiCoder.decode(["string"], "0x" + error.data.toString().slice(10));
            console.log(`   Error string: ${decoded[0]}`);
          } catch {}
        }
        // Try treasury errors
        try {
          const decoded = treasury.interface.parseError(error.data);
          console.log(`   Decoded treasury error: ${decoded.name}(${JSON.stringify(decoded.args)})`);
        } catch {}
      }
    }
  }

  // Verify pool states
  console.log("\n3. Verifying pool states...");
  const PoolFactory = await ethers.getContractFactory("LPPPool");
  for (let i = 0; i < 4; i++) {
    const pool = PoolFactory.attach(pools[i]).connect(provider);
    try {
      const asset = await pool.asset();
      const usdc = await pool.usdc();
      const initialized = await pool.initialized();
      console.log(`   Pool${i}: asset=${asset}, usdc=${usdc}, initialized=${initialized}`);
    } catch (error: any) {
      console.log(`   Pool${i}: ERROR - ${error.message}`);
    }
  }
}

main().catch(console.error);

