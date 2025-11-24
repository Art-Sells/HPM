import hre from "hardhat";
const { ethers } = hre;

async function main() {
  const provider = ethers.provider;
  const deployerPk = process.env.PRIVATE_KEY_DEPLOYER || process.env.PRIVATE_KEY;
  if (!deployerPk) throw new Error("Set PRIVATE_KEY");
  const deployer = new ethers.Wallet(deployerPk, provider);
  
  const fs = await import("fs");
  const manifest = JSON.parse(fs.default.readFileSync("deployment-manifest.json", "utf8"));
  const poolManifest = JSON.parse(fs.default.readFileSync("pool-manifest.json", "utf8"));
  
  const treasuryAddr = manifest.contracts.LPPTreasury;
  const routerAddr = manifest.contracts.LPPRouter;
  
  const pools = [
    poolManifest.pools.pool0.address,
    poolManifest.pools.pool1.address,
    poolManifest.pools.pool2.address,
    poolManifest.pools.pool3.address,
  ];
  const negOrbit = [pools[0], pools[1]];
  const posOrbit = [pools[2], pools[3]];
  
  const TreasuryFactory = await ethers.getContractFactory("LPPTreasury");
  const treasury = TreasuryFactory.attach(treasuryAddr).connect(deployer);
  
  console.log("=== Testing Actual Transaction ===");
  console.log("Deployer:", await deployer.getAddress());
  console.log("Treasury owner:", await treasury.owner());
  console.log("Treasury address:", treasuryAddr);
  console.log("Router address:", routerAddr);
  console.log("Pool0 (startPool):", pools[0]);
  console.log("NEG orbit:", negOrbit);
  console.log("POS orbit:", posOrbit);
  console.log("");
  
  // Check if deployer is owner
  const treasuryOwner = await treasury.owner();
  if (treasuryOwner.toLowerCase() !== (await deployer.getAddress()).toLowerCase()) {
    throw new Error(`Deployer is not treasury owner. Owner: ${treasuryOwner}`);
  }
  console.log("✓ Deployer is treasury owner");
  
  // Check router's treasury
  const RouterFactory = await ethers.getContractFactory("LPPRouter");
  const router = RouterFactory.attach(routerAddr).connect(provider);
  const routerTreasury = await router.treasury();
  if (routerTreasury.toLowerCase() !== treasuryAddr.toLowerCase()) {
    throw new Error(`Router treasury mismatch. Router expects: ${routerTreasury}, We have: ${treasuryAddr}`);
  }
  console.log("✓ Router's treasury matches our treasury");
  console.log("");
  
  console.log("Sending transaction...");
  try {
    const tx = await treasury.setDualOrbitViaTreasury(
      routerAddr,
      pools[0],
      negOrbit,
      posOrbit,
      true
    );
    console.log("✓ Transaction sent:", tx.hash);
    console.log("View on BaseScan: https://basescan.org/tx/" + tx.hash);
    console.log("Waiting for confirmation...");
    
    const receipt = await tx.wait();
    if (receipt && receipt.status === 1) {
      console.log("✓ SUCCESS! Orbit registered. Status:", receipt.status);
    } else {
      console.log("❌ Transaction failed. Status:", receipt?.status);
    }
  } catch (e: any) {
    console.error("❌ Error:", e.message);
    if (e.reason) console.error("Reason:", e.reason);
    if (e.data) {
      console.error("Error data:", e.data);
      // Try to decode
      try {
        const routerIface = RouterFactory.interface;
        const decoded = routerIface.parseError(e.data);
        if (decoded) {
          console.error("Decoded router error:", decoded.name, decoded.args);
        }
      } catch {}
      try {
        const treasuryIface = TreasuryFactory.interface;
        const decoded = treasuryIface.parseError(e.data);
        if (decoded) {
          console.error("Decoded treasury error:", decoded.name, decoded.args);
        }
      } catch {}
    }
    if (e.transaction?.hash) {
      console.error("Transaction hash:", e.transaction.hash);
    }
  }
}

main().catch(console.error);

