// Test if router can actually call pool.asset() and pool.usdc()
import hre from "hardhat";
const { ethers } = hre;
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const provider = ethers.provider;
  
  const pools = [
    "0xb5889070070C9A666bd411E4D882e3E545f74aE0", // Pool0
    "0xa6c62A4edf110703f69505Ea8fAD940aDc6EAF9D", // Pool1
    "0x439634467E0322759b1a7369a552204ea42A3463", // Pool2
    "0xB1a5D1943612BbEE35ee7720f3a4bba74Fdc68b7", // Pool3
  ];

  const negOrbit = [pools[0], pools[1]];
  const posOrbit = [pools[2], pools[3]];

  console.log("Testing if router can read from pools...\n");

  // Simulate what router.setDualOrbit does internally
  const PoolFactory = await ethers.getContractFactory("FAFEPool");
  
  console.log("1. Testing pool.asset() and pool.usdc() calls...");
  for (let i = 0; i < 4; i++) {
    const pool = PoolFactory.attach(pools[i]).connect(provider);
    try {
      const asset = await pool.asset();
      const usdc = await pool.usdc();
      console.log(`   Pool${i}: asset=${asset}, usdc=${usdc} ✓`);
    } catch (error: any) {
      console.log(`   Pool${i}: ERROR - ${error.message}`);
    }
  }

  console.log("\n2. Simulating router validation logic...");
  // This is what setDualOrbit does:
  // address a0 = IFAFEPool(neg[0]).asset();
  // address u0 = IFAFEPool(neg[0]).usdc();
  try {
    const pool0 = PoolFactory.attach(negOrbit[0]).connect(provider);
    const a0 = await pool0.asset();
    const u0 = await pool0.usdc();
    console.log(`   neg[0] (Pool0): a0=${a0}, u0=${u0} ✓`);

    // Check neg[1]
    const pool1 = PoolFactory.attach(negOrbit[1]).connect(provider);
    const a1 = await pool1.asset();
    const u1 = await pool1.usdc();
    console.log(`   neg[1] (Pool1): a1=${a1}, u1=${u1} ✓`);
    console.log(`   Match check: ${a1 === a0 && u1 === u0} (should be true)`);

    // Check pos[0]
    const pool2 = PoolFactory.attach(posOrbit[0]).connect(provider);
    const a2 = await pool2.asset();
    const u2 = await pool2.usdc();
    console.log(`   pos[0] (Pool2): a2=${a2}, u2=${u2} ✓`);
    console.log(`   Match check: ${a2 === a0 && u2 === u0} (should be true)`);

    // Check pos[1]
    const pool3 = PoolFactory.attach(posOrbit[1]).connect(provider);
    const a3 = await pool3.asset();
    const u3 = await pool3.usdc();
    console.log(`   pos[1] (Pool3): a3=${a3}, u3=${u3} ✓`);
    console.log(`   Match check: ${a3 === a0 && u3 === u0} (should be true)`);

    // All should match
    const allMatch = (a1 === a0 && u1 === u0) && (a2 === a0 && u2 === u0) && (a3 === a0 && u3 === u0);
    console.log(`\n   All pools match: ${allMatch} (should be true)`);
    
    if (!allMatch) {
      console.log("   ❌ Token pair mismatch detected!");
    } else {
      console.log("   ✓ All validation checks should pass");
    }
  } catch (error: any) {
    console.log(`   ❌ Error during validation simulation: ${error.message}`);
  }

  // Check if pools have code
  console.log("\n3. Checking if pools have contract code...");
  for (let i = 0; i < 4; i++) {
    const code = await provider.getCode(pools[i]);
    console.log(`   Pool${i}: ${code.length} bytes ${code === "0x" ? "❌ NO CODE" : "✓"}`);
  }
}

main().catch(console.error);

