// Check if the deployed router matches our compiled version
import hre from "hardhat";
const { ethers } = hre;
import * as dotenv from "dotenv";
import * as fs from "fs";
dotenv.config();

async function main() {
  const provider = ethers.provider;
  const manifest = JSON.parse(fs.readFileSync("deployment-manifest.json", "utf-8"));
  const routerAddr = manifest.contracts.LPPRouter;

  console.log("=== Router Contract Verification ===\n");

  // 1. Get deployed bytecode
  const deployedCode = await provider.getCode(routerAddr);
  console.log(`1. Deployed bytecode length: ${deployedCode.length} bytes`);

  // 2. Get our compiled bytecode
  const RouterFactory = await ethers.getContractFactory("LPPRouter");
  const compiledCode = RouterFactory.bytecode;
  console.log(`2. Compiled bytecode length: ${compiledCode.length} bytes`);

  // 3. Check function selectors
  console.log("\n3. Function selectors:");
  const setDualOrbitSelector = RouterFactory.interface.getFunction("setDualOrbit").selector;
  console.log(`   setDualOrbit selector: ${setDualOrbitSelector}`);
  
  // Check if selector exists in deployed code
  const selectorInCode = deployedCode.includes(setDualOrbitSelector.slice(2));
  console.log(`   Selector found in deployed code: ${selectorInCode}`);

  // 4. Try to read router state variables
  console.log("\n4. Reading router state:");
  const router = RouterFactory.attach(routerAddr).connect(provider);
  try {
    const treasury = await router.treasury();
    console.log(`   Treasury: ${treasury}`);
    
    const paused = await router.paused();
    console.log(`   Paused: ${paused}`);
    
    const dailyCap = await router.dailyEventCap();
    console.log(`   Daily cap: ${dailyCap}`);
  } catch (error: any) {
    console.log(`   ❌ Error reading state: ${error.message}`);
  }

  // 5. Try to manually construct the exact call the router would make
  console.log("\n5. Testing pool interface calls (what router does internally):");
  const pools = [
    "0xb5889070070C9A666bd411E4D882e3E545f74aE0", // Pool0
    "0xa6c62A4edf110703f69505Ea8fAD940aDc6EAF9D", // Pool1
    "0x439634467E0322759b1a7369a552204ea42A3463", // Pool2
    "0xB1a5D1943612BbEE35ee7720f3a4bba74Fdc68b7", // Pool3
  ];

  const PoolFactory = await ethers.getContractFactory("LPPPool");
  const ILPPPool_ABI = [
    "function asset() external view returns (address)",
    "function usdc() external view returns (address)",
  ];
  
  // Simulate what router.setDualOrbit does:
  // address a0 = ILPPPool(neg[0]).asset();
  // address u0 = ILPPPool(neg[0]).usdc();
  console.log("   Simulating router's internal calls...");
  try {
    const pool0 = new ethers.Contract(pools[0], ILPPPool_ABI, provider);
    const a0 = await pool0.asset();
    const u0 = await pool0.usdc();
    console.log(`   neg[0].asset() = ${a0}`);
    console.log(`   neg[0].usdc() = ${u0}`);
    
    // Check if all pools match
    for (let i = 1; i < 4; i++) {
      const pool = new ethers.Contract(pools[i], ILPPPool_ABI, provider);
      const ai = await pool.asset();
      const ui = await pool.usdc();
      const match = (ai === a0 && ui === u0);
      console.log(`   Pool${i}: asset=${ai}, usdc=${ui}, match=${match}`);
      if (!match) {
        console.log(`   ❌ Pool${i} doesn't match! This would cause "dual: NEG mismatch" or "dual: POS mismatch"`);
      }
    }
  } catch (error: any) {
    console.log(`   ❌ Error calling pool interface: ${error.message}`);
  }

  // 6. Check if maybe the issue is with how we're encoding the arrays
  console.log("\n6. Testing array encoding:");
  const negOrbit = [pools[0], pools[1]];
  const posOrbit = [pools[2], pools[3]];
  
  const iface = RouterFactory.interface;
  const encoded = iface.encodeFunctionData("setDualOrbit", [
    pools[0],
    negOrbit,
    posOrbit,
    true
  ]);
  console.log(`   Encoded call data length: ${encoded.length} bytes`);
  console.log(`   First 100 chars: ${encoded.slice(0, 100)}...`);

  // 7. Try calling router.setDualOrbit with explicit from address (treasury)
  console.log("\n7. Testing with explicit 'from' address (treasury):");
  const treasuryAddr = manifest.contracts.LPPTreasury;
  
  try {
    // Use callStatic with explicit from
    const result = await provider.call({
      to: routerAddr,
      data: encoded,
      from: treasuryAddr, // This is key - router checks msg.sender == treasury
    });
    console.log(`   ✓ Call succeeded: ${result}`);
  } catch (error: any) {
    console.log(`   ❌ Call failed: ${error.message}`);
    if (error.data) {
      console.log(`   Error data: ${error.data}`);
      // Try to decode
      try {
        const decoded = iface.parseError(error.data);
        console.log(`   Decoded: ${decoded.name}(${JSON.stringify(decoded.args)})`);
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
}

main().catch(console.error);

