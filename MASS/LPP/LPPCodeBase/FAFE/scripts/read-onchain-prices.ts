// scripts/read-onchain-prices.ts
// Read current on-chain prices from all pools

import hre from "hardhat";
const { ethers } = hre;
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
dotenv.config();

async function main() {
  const provider = ethers.provider;
  
  // Load addresses from deployment manifest
  const manifestPath = path.join(process.cwd(), "test/Deployment/deployment-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("deployment-manifest.json not found.");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const pools = manifest.pools;
  const assetDecimals = 8;
  const usdcDecimals = 6;
  
  console.log("=== Current On-Chain Prices (USDC per cbBTC) ===\n");
  console.log("External cbBTC price: 88,222.71 USDC per cbBTC\n");
  
  // Helper to convert priceX96 to USDC per cbBTC
  function priceX96ToUsdcPerCbbtc(priceX96: bigint): string {
    const priceRatio = Number(priceX96) / Math.pow(2, 96);
    const decimalAdjustment = Math.pow(10, assetDecimals) / Math.pow(10, usdcDecimals); // 100
    return (priceRatio * decimalAdjustment).toFixed(2);
  }
  
  const PoolFactory = await ethers.getContractFactory("FAFEPool");
  
  const poolList = [
    { key: "pool0", addr: pools.pool0.address, orbit: "NEG" },
    { key: "pool1", addr: pools.pool1.address, orbit: "NEG" },
    { key: "pool2", addr: pools.pool2.address, orbit: "POS" },
    { key: "pool3", addr: pools.pool3.address, orbit: "POS" },
  ];
  
  for (const poolInfo of poolList) {
    const pool = PoolFactory.attach(poolInfo.addr).connect(provider);
    const priceX96 = await pool.priceX96();
    const offset = await pool.targetOffsetBps();
    const reserveAsset = await pool.reserveAsset();
    const reserveUsdc = await pool.reserveUsdc();
    
    const price = priceX96ToUsdcPerCbbtc(priceX96);
    const assetFormatted = ethers.formatUnits(reserveAsset, assetDecimals);
    const usdcFormatted = ethers.formatUnits(reserveUsdc, usdcDecimals);
    
    console.log(`${poolInfo.key.toUpperCase()} (${poolInfo.orbit} orbit):`);
    console.log(`  Address: ${poolInfo.addr}`);
    console.log(`  Offset: ${Number(offset)}`);
    console.log(`  Price: ${price} USDC per cbBTC`);
    console.log(`  Reserves: ${assetFormatted} cbBTC / ${usdcFormatted} USDC`);
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


