import hre from "hardhat";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";

dotenv.config();

const { ethers } = hre;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const manifestPath = path.resolve(__dirname, "../deployment-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const treasuryAddr = manifest.contracts.FAFETreasury;
  const assetAddr = manifest.tokens.ASSET;
  const usdcAddr = manifest.tokens.USDC;

  const signerKey = process.env.TREASURY_OPS_KEY || process.env.PRIVATE_KEY;
  if (!signerKey) {
    throw new Error("Missing signer key (TREASURY_OPS_KEY or PRIVATE_KEY)");
  }

  const signer = new ethers.Wallet(signerKey, ethers.provider);

  const asset = await ethers.getContractAt("IERC20", assetAddr, signer);
  const usdc = await ethers.getContractAt("IERC20", usdcAddr, signer);

  const assetAmount = process.env.FAFE_ASSET_AMOUNT
    ? ethers.parseUnits(process.env.FAFE_ASSET_AMOUNT, 8)
    : ethers.parseUnits("0.000012", 8);
  const usdcAmount = process.env.FAFE_USDC_AMOUNT
    ? ethers.parseUnits(process.env.FAFE_USDC_AMOUNT, 6)
    : ethers.parseUnits("0.50", 6);

  console.log("Signer:", signer.address);
  console.log("Funding treasury:", treasuryAddr);
  console.log("cbBTC amount:", ethers.formatUnits(assetAmount, 8));
  console.log("USDC amount:", ethers.formatUnits(usdcAmount, 6));

  const assetTx = await asset.transfer(treasuryAddr, assetAmount);
  await assetTx.wait();
  console.log("cbBTC transfer hash:", assetTx.hash);

  const usdcTx = await usdc.transfer(treasuryAddr, usdcAmount);
  await usdcTx.wait();
  console.log("USDC transfer hash:", usdcTx.hash);

  console.log("Funding complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

