// Try to manually decode the revert reason using different methods
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

  const TreasuryFactory = await ethers.getContractFactory("LPPTreasury");
  const treasury = TreasuryFactory.attach(treasuryAddr).connect(deployer);
  const RouterFactory = await ethers.getContractFactory("LPPRouter");

  console.log("Attempting to call and capture full error response...\n");

  // Method 1: Try with explicit error handling
  try {
    const result = await treasury.setDualOrbitViaTreasury.staticCall(
      routerAddr,
      pools[0],
      negOrbit,
      posOrbit,
      true
    );
    console.log("✓ Static call succeeded:", result);
  } catch (error: any) {
    console.log("❌ Static call failed");
    console.log("Error object keys:", Object.keys(error));
    console.log("Error message:", error.message);
    console.log("Error code:", error.code);
    console.log("Error reason:", error.reason);
    console.log("Error data:", error.data);
    console.log("Error error:", error.error);
    
    // Try to get error from nested error object
    if (error.error) {
      console.log("\nNested error:");
      console.log("  Message:", error.error.message);
      console.log("  Data:", error.error.data);
      console.log("  Code:", error.error.code);
    }

    // Try all possible error decoding methods
    const errorData = error.data || error.error?.data || error.error?.error?.data;
    if (errorData) {
      console.log("\n=== Attempting to decode error data ===");
      console.log("Raw error data:", errorData);
      console.log("Error data length:", errorData.length);
      
      // Method 1: Try router interface
      try {
        const decoded = RouterFactory.interface.parseError(errorData);
        console.log(`✓ Decoded as router error: ${decoded.name}(${JSON.stringify(decoded.args)})`);
      } catch (e) {
        console.log("✗ Not a router custom error");
      }

      // Method 2: Try treasury interface
      try {
        const decoded = treasury.interface.parseError(errorData);
        console.log(`✓ Decoded as treasury error: ${decoded.name}(${JSON.stringify(decoded.args)})`);
      } catch (e) {
        console.log("✗ Not a treasury custom error");
      }

      // Method 3: Try Error(string) - selector 0x08c379a0
      if (errorData.toString().startsWith("0x08c379a0")) {
        try {
          const abiCoder = new ethers.AbiCoder();
          const decoded = abiCoder.decode(["string"], "0x" + errorData.toString().slice(10));
          console.log(`✓ Decoded as Error(string): "${decoded[0]}"`);
        } catch (e) {
          console.log("✗ Failed to decode Error(string)");
        }
      } else {
        console.log("✗ Not Error(string) format (doesn't start with 0x08c379a0)");
      }

      // Method 4: Try Panic(uint256) - selector 0x4e487b71
      if (errorData.toString().startsWith("0x4e487b71")) {
        try {
          const abiCoder = new ethers.AbiCoder();
          const decoded = abiCoder.decode(["uint256"], "0x" + errorData.toString().slice(10));
          const panicCodes: Record<string, string> = {
            "0x01": "assert(false)",
            "0x11": "arithmetic underflow/overflow",
            "0x12": "division by zero",
            "0x21": "converted enum value out of bounds",
            "0x22": "incorrectly encoded storage byte array",
            "0x31": "pop() on empty array",
            "0x32": "array index out of bounds",
            "0x41": "too much memory allocated",
            "0x51": "zero-initialized variable of internal function type",
          };
          const code = "0x" + decoded[0].toString(16).padStart(2, "0");
          console.log(`✓ Decoded as Panic: ${panicCodes[code] || `unknown panic code ${code}`}`);
        } catch (e) {
          console.log("✗ Failed to decode Panic");
        }
      } else {
        console.log("✗ Not Panic format (doesn't start with 0x4e487b71)");
      }

      // Method 5: Try to extract any readable string from the data
      try {
        const dataStr = errorData.toString();
        // Look for any ASCII strings in the data
        const asciiMatch = dataStr.match(/[ -~]{4,}/g);
        if (asciiMatch) {
          console.log(`✓ Found ASCII strings in data: ${asciiMatch.join(", ")}`);
        }
      } catch (e) {
        // Ignore
      }
    } else {
      console.log("\n⚠ No error data found to decode");
    }

    // Method 6: Try to get error from transaction receipt if it was sent
    if (error.transaction || error.receipt) {
      console.log("\n=== Transaction Info ===");
      if (error.transaction?.hash) {
        console.log("Transaction hash:", error.transaction.hash);
        try {
          const receipt = await provider.getTransactionReceipt(error.transaction.hash);
          if (receipt) {
            console.log("Receipt status:", receipt.status);
            if (receipt.status === 0 && receipt.logs.length === 0) {
              console.log("⚠ Transaction reverted but no revert reason in receipt");
            }
          }
        } catch (e) {
          console.log("Could not fetch receipt");
        }
      }
    }
  }

  // Method 7: Try calling router.setDualOrbit directly (will fail with "not treasury" but let's see the error format)
  console.log("\n\n=== Testing direct router call format ===");
  const RouterFactory2 = await ethers.getContractFactory("LPPRouter");
  const router = RouterFactory2.attach(routerAddr).connect(provider);
  
  try {
    await router.setDualOrbit.staticCall(pools[0], negOrbit, posOrbit, true);
  } catch (error: any) {
    console.log("Direct router call error:", error.message);
    if (error.data) {
      console.log("Error data:", error.data);
      try {
        const decoded = RouterFactory2.interface.parseError(error.data);
        console.log(`Decoded: ${decoded.name}(${JSON.stringify(decoded.args)})`);
      } catch (e) {
        // Try Error(string)
        if (error.data.toString().startsWith("0x08c379a0")) {
          try {
            const abiCoder = new ethers.AbiCoder();
            const decoded = abiCoder.decode(["string"], "0x" + error.data.toString().slice(10));
            console.log(`Error string: "${decoded[0]}"`);
          } catch {}
        }
      }
    }
  }
}

main().catch(console.error);

