// Manually construct and send the orbit registration transaction
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

  console.log("Attempting to register orbit for Pool0...");
  console.log(`Router: ${routerAddr}`);
  console.log(`StartPool: ${pools[0]}`);
  console.log(`NEG orbit: ${negOrbit.join(", ")}`);
  console.log(`POS orbit: ${posOrbit.join(", ")}`);

  // Get current gas price
  const feeData = await provider.getFeeData();
  console.log(`\nCurrent gas prices:`);
  console.log(`  maxFeePerGas: ${ethers.formatUnits(feeData.maxFeePerGas || 0n, "gwei")} gwei`);
  console.log(`  maxPriorityFeePerGas: ${ethers.formatUnits(feeData.maxPriorityFeePerGas || 0n, "gwei")} gwei`);

  // Try to estimate gas first
  console.log(`\nEstimating gas...`);
  try {
    const gasEstimate = await treasury.setDualOrbitViaTreasury.estimateGas(
      routerAddr,
      pools[0],
      negOrbit,
      posOrbit,
      true
    );
    console.log(`  Gas estimate: ${gasEstimate.toString()}`);
  } catch (estimateError: any) {
    console.log(`  ❌ Gas estimation failed: ${estimateError.message}`);
    if (estimateError.data) {
      console.log(`  Error data: ${estimateError.data}`);
      // Try to decode
      try {
        const RouterFactory = await ethers.getContractFactory("LPPRouter");
        const routerIface = RouterFactory.interface;
        const decoded = routerIface.parseError(estimateError.data);
        if (decoded) {
          console.log(`  Decoded router error: ${decoded.name}(${JSON.stringify(decoded.args)})`);
        }
      } catch {
        // Try Error(string)
        if (estimateError.data.toString().startsWith("0x08c379a0")) {
          try {
            const abiCoder = new ethers.AbiCoder();
            const decoded = abiCoder.decode(["string"], "0x" + estimateError.data.toString().slice(10));
            console.log(`  Error string: "${decoded[0]}"`);
          } catch {}
        }
      }
    }
    return;
  }

  // If gas estimation succeeded, try sending the transaction
  console.log(`\nSending transaction...`);
  try {
    const tx = await treasury.setDualOrbitViaTreasury(
      routerAddr,
      pools[0],
      negOrbit,
      posOrbit,
      true,
      {
        // Use explicit gas limit (add 20% buffer)
        gasLimit: 500000n,
      }
    );
    
    console.log(`  ✓ Transaction sent: ${tx.hash}`);
    console.log(`  View on BaseScan: https://basescan.org/tx/${tx.hash}`);
    
    console.log(`  Waiting for confirmation...`);
    const receipt = await tx.wait();
    
    if (receipt && receipt.status === 1) {
      console.log(`  ✓ Transaction confirmed! Orbit registered successfully.`);
    } else {
      console.log(`  ❌ Transaction failed with status: ${receipt?.status}`);
    }
  } catch (txError: any) {
    console.log(`  ❌ Transaction failed: ${txError.message}`);
    if (txError.reason) {
      console.log(`  Revert reason: ${txError.reason}`);
    }
    if (txError.data) {
      console.log(`  Error data: ${txError.data}`);
    }
    if (txError.transaction?.hash) {
      console.log(`  Transaction hash: ${txError.transaction.hash}`);
      console.log(`  Check BaseScan: https://basescan.org/tx/${txError.transaction.hash}`);
    }
  }
}

main().catch(console.error);

