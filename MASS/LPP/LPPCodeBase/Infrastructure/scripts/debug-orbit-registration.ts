import hre from "hardhat";
const { ethers } = hre;

async function main() {
  const provider = ethers.provider;
  
  // Read addresses from manifest
  const fs = await import("fs");
  const manifestPath = "deployment-manifest.json";
  const manifest = JSON.parse(fs.default.readFileSync(manifestPath, "utf8"));
  
  const treasuryAddr = manifest.contracts.LPPTreasury;
  const routerAddr = manifest.contracts.LPPRouter;
  
  // Read pool addresses from pool manifest
  const poolManifestPath = "pool-manifest.json";
  const poolManifest = JSON.parse(fs.default.readFileSync(poolManifestPath, "utf8"));
  const pools = [
    poolManifest.pools.pool0.address,
    poolManifest.pools.pool1.address,
    poolManifest.pools.pool2.address,
    poolManifest.pools.pool3.address,
  ];
  
  const negOrbit = [pools[0], pools[1]];
  const posOrbit = [pools[2], pools[3]];
  
  console.log("=== Debugging Orbit Registration ===\n");
  console.log("Treasury:", treasuryAddr);
  console.log("Router:", routerAddr);
  console.log("Pools:", pools);
  console.log("NEG Orbit:", negOrbit);
  console.log("POS Orbit:", posOrbit);
  console.log("");
  
  // Get contract instances
  const RouterFactory = await ethers.getContractFactory("LPPRouter");
  const TreasuryFactory = await ethers.getContractFactory("LPPTreasury");
  const PoolFactory = await ethers.getContractFactory("LPPPool");
  
  const router = RouterFactory.attach(routerAddr).connect(provider);
  const treasury = TreasuryFactory.attach(treasuryAddr).connect(provider);
  
  // 1. Check router's treasury
  console.log("1. Checking router's treasury...");
  const routerTreasury = await router.treasury();
  console.log(`   Router treasury: ${routerTreasury}`);
  console.log(`   Our treasury: ${treasuryAddr}`);
  console.log(`   Match: ${routerTreasury.toLowerCase() === treasuryAddr.toLowerCase() ? "✓" : "❌"}`);
  console.log("");
  
  // 2. Check router's paused state
  console.log("2. Checking router's paused state...");
  const isPaused = await router.paused();
  console.log(`   Router paused: ${isPaused}`);
  console.log("");
  
  // 3. Check if orbits are already registered
  console.log("3. Checking existing orbit registrations...");
  for (let i = 0; i < 4; i++) {
    try {
      const dualOrbit = await router.getDualOrbit(pools[i]);
      console.log(`   Pool${i} (${pools[i]}):`);
      console.log(`      NEG: ${dualOrbit[0].length} pools - ${dualOrbit[0].join(", ")}`);
      console.log(`      POS: ${dualOrbit[1].length} pools - ${dualOrbit[1].join(", ")}`);
      console.log(`      Initialized: ${dualOrbit[2]}`);
    } catch (e: any) {
      console.log(`   Pool${i} (${pools[i]}): NOT REGISTERED - ${e.message}`);
    }
  }
  console.log("");
  
  // 4. Verify pool states
  console.log("4. Verifying pool states...");
  for (let i = 0; i < 4; i++) {
    const pool = PoolFactory.attach(pools[i]).connect(provider);
    const asset = await pool.asset();
    const usdc = await pool.usdc();
    const initialized = await pool.initialized();
    const routerAddrOnPool = await pool.router();
    console.log(`   Pool${i} (${pools[i]}):`);
    console.log(`      Asset: ${asset}`);
    console.log(`      USDC: ${usdc}`);
    console.log(`      Initialized: ${initialized}`);
    console.log(`      Router set: ${routerAddrOnPool}`);
    console.log(`      Router matches: ${routerAddrOnPool.toLowerCase() === routerAddr.toLowerCase() ? "✓" : "❌"}`);
  }
  console.log("");
  
  // 5. Check token pair consistency
  console.log("5. Checking token pair consistency...");
  const pool0 = PoolFactory.attach(pools[0]).connect(provider);
  const pool0Asset = await pool0.asset();
  const pool0Usdc = await pool0.usdc();
  console.log(`   Pool0 tokens: ${pool0Asset}/${pool0Usdc}`);
  
  for (let i = 1; i < 4; i++) {
    const pool = PoolFactory.attach(pools[i]).connect(provider);
    const asset = await pool.asset();
    const usdc = await pool.usdc();
    const matches = asset.toLowerCase() === pool0Asset.toLowerCase() && 
                    usdc.toLowerCase() === pool0Usdc.toLowerCase();
    console.log(`   Pool${i} tokens: ${asset}/${usdc} - ${matches ? "✓" : "❌ MISMATCH"}`);
  }
  console.log("");
  
  // 6. Get deployer wallet
  const deployerPk = process.env.PRIVATE_KEY_DEPLOYER || process.env.PRIVATE_KEY;
  if (!deployerPk) {
    throw new Error("Set PRIVATE_KEY_DEPLOYER or PRIVATE_KEY in .env");
  }
  const deployer = new ethers.Wallet(deployerPk, provider);
  console.log(`   Deployer: ${await deployer.getAddress()}`);
  console.log("");
  
  // 7. Try calling through treasury (static call with deployer)
  console.log("7. Simulating setDualOrbitViaTreasury call (static with deployer)...");
  try {
    const treasuryWithSigner = TreasuryFactory.attach(treasuryAddr).connect(deployer);
    console.log(`   Calling with deployer: ${await deployer.getAddress()}`);
    console.log(`   Treasury owner check...`);
    const treasuryOwner = await treasury.owner();
    console.log(`   Treasury owner: ${treasuryOwner}`);
    console.log(`   Deployer is owner: ${treasuryOwner.toLowerCase() === (await deployer.getAddress()).toLowerCase()}`);
    
    const result = await treasuryWithSigner.setDualOrbitViaTreasury.staticCall(
      routerAddr,
      pools[0],
      negOrbit,
      posOrbit,
      true
    );
    console.log("   ✓ Static call succeeded");
  } catch (e: any) {
    console.log(`   ❌ Static call failed: ${e.message}`);
    if (e.reason) {
      console.log(`   Revert reason: ${e.reason}`);
    }
    if (e.data) {
      console.log(`   Error data: ${e.data}`);
      // Try to decode
      try {
        const routerIface = RouterFactory.interface;
        const decoded = routerIface.parseError(e.data);
        if (decoded) {
          console.log(`   Decoded router error: ${decoded.name}(${JSON.stringify(decoded.args)})`);
        }
      } catch {}
      try {
        const treasuryIface = TreasuryFactory.interface;
        const decoded = treasuryIface.parseError(e.data);
        if (decoded) {
          console.log(`   Decoded treasury error: ${decoded.name}(${JSON.stringify(decoded.args)})`);
        }
      } catch {}
    }
    // Check for specific error messages
    if (e.message.includes("not treasury")) {
      console.log(`   ⚠ This is a 'not treasury' error - the router's onlyTreasury check is failing`);
    }
    if (e.message.includes("zero")) {
      console.log(`   ⚠ This might be a zero address check failing`);
    }
    if (e.message.includes("length")) {
      console.log(`   ⚠ This might be a length mismatch check failing`);
    }
  }
}

main().catch(console.error);

