import hre from "hardhat";
const { ethers } = hre;
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
dotenv.config();

async function main() {
  const provider = ethers.provider;
  const deployerPk = process.env.PRIVATE_KEY_DEPLOYER || process.env.PRIVATE_KEY;
  if (!deployerPk) {
    throw new Error("Set PRIVATE_KEY_DEPLOYER or PRIVATE_KEY in .env");
  }
  const deployer = new ethers.Wallet(deployerPk, provider);
  
  console.log("Checking pools from previous run...\n");
  
  const previousRunPools = [
    { name: "Pool0", addr: "0xb5889070070C9A666bd411E4D882e3E545f74aE0" },
    { name: "Pool1", addr: "0xa6c62A4edf110703f69505Ea8fAD940aDc6EAF9D" },
    { name: "Pool2", addr: "0x439634467E0322759b1a7369a552204ea42A3463" },
    { name: "Pool3", addr: "0xB1a5D1943612BbEE35ee7720f3a4bba74Fdc68b7" },
  ];
  
  const PoolFactory = await ethers.getContractFactory("LPPPool");
  const FactoryFactory = await ethers.getContractFactory("LPPFactory");
  const factoryAddr = "0x6e5f60615f45d4A1716764A20dbD3EdE014F23ed";
  const factory = FactoryFactory.attach(factoryAddr).connect(provider);
  
  const assetAddr = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
  const usdcAddr = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  // Use ERC20 ABI to read decimals
  const erc20Abi = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
  ];
  const asset = new ethers.Contract(assetAddr, erc20Abi, provider);
  const usdc = new ethers.Contract(usdcAddr, erc20Abi, provider);
  
  const assetDecimals = await asset.decimals();
  const usdcDecimals = await usdc.decimals();
  
  for (const poolInfo of previousRunPools) {
    console.log(`\n${poolInfo.name} (${poolInfo.addr}):`);
    try {
      const pool = PoolFactory.attach(poolInfo.addr).connect(provider);
      const isPool = await factory.isPool(poolInfo.addr);
      const isInitialized = await pool.initialized();
      const reserveAsset = await pool.reserveAsset();
      const reserveUsdc = await pool.reserveUsdc();
      const poolAssetBal = await asset.balanceOf(poolInfo.addr);
      const poolUsdcBal = await usdc.balanceOf(poolInfo.addr);
      
      console.log(`  Is registered in factory: ${isPool}`);
      console.log(`  Is initialized: ${isInitialized}`);
      console.log(`  Reserve ASSET: ${ethers.formatUnits(reserveAsset, assetDecimals)}`);
      console.log(`  Reserve USDC: ${ethers.formatUnits(reserveUsdc, usdcDecimals)}`);
      console.log(`  Pool ASSET balance: ${ethers.formatUnits(poolAssetBal, assetDecimals)}`);
      console.log(`  Pool USDC balance: ${ethers.formatUnits(poolUsdcBal, usdcDecimals)}`);
      
      if (!isInitialized && (poolAssetBal > 0n || poolUsdcBal > 0n)) {
        console.log(`  ⚠ WARNING: Pool has tokens but is NOT initialized!`);
      }
    } catch (error: any) {
      console.log(`  ❌ Error checking pool: ${error.message}`);
    }
  }
  
  // Check treasury balance
  const treasuryAddr = "0x2B12D3CB3769538896E94707a3Bb1d335CE5B20b";
  const treasuryAssetBal = await asset.balanceOf(treasuryAddr);
  const treasuryUsdcBal = await usdc.balanceOf(treasuryAddr);
  console.log(`\nTreasury contract (${treasuryAddr}):`);
  console.log(`  ASSET balance: ${ethers.formatUnits(treasuryAssetBal, assetDecimals)}`);
  console.log(`  USDC balance: ${ethers.formatUnits(treasuryUsdcBal, usdcDecimals)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

