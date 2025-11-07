// scripts/deploy.ts
import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const provider = ethers.provider;

  // 1) Load treasury EOA
  const pk = process.env.PRIVATE_KEY_TREASURY;
  if (!pk) throw new Error("Set PRIVATE_KEY_TREASURY in .env");
  const treasuryEOA = new ethers.Wallet(pk, provider);

  // 2) Deploy core
  const TreasuryC = await ethers.getContractFactory("LPPTreasury", treasuryEOA);
  const treasury = await TreasuryC.deploy(await treasuryEOA.getAddress(), await treasuryEOA.getAddress());
  await treasury.waitForDeployment();

  const Vault = await (await ethers.getContractFactory("LPPRebateVault", treasuryEOA)).deploy();
  await Vault.waitForDeployment();

  const Hook = await (await ethers.getContractFactory("LPPMintHook", treasuryEOA))
    .deploy(await treasury.getAddress(), await Vault.getAddress());
  await Hook.waitForDeployment();

  const Factory = await (await ethers.getContractFactory("LPPFactory", treasuryEOA))
    .deploy(await treasuryEOA.getAddress()); // constructor(treasury)
  await Factory.waitForDeployment();

  const Token = await ethers.getContractFactory("TestToken", treasuryEOA);
  const asset = await Token.deploy("Asset", "ASSET");
  const usdc  = await Token.deploy("USD Coin", "USDC");
  await asset.waitForDeployment();
  await usdc.waitForDeployment();

  // Fund EOA for bootstrap (test tokens)
  await asset.mint(await treasuryEOA.getAddress(), ethers.parseEther("1000"));
  await usdc.mint(await treasuryEOA.getAddress(),  ethers.parseEther("1000"));

  // Treasury-only flow:
  await Factory.connect(treasuryEOA).createPool(await asset.getAddress(), await usdc.getAddress());
  const poolAddr = (await Factory.getPools())[0];
  const pool = await ethers.getContractAt("LPPPool", poolAddr, treasuryEOA);

  await Factory.connect(treasuryEOA).setPoolHook(poolAddr, await Hook.getAddress());
  await Hook.connect(treasuryEOA).bootstrap(
    poolAddr,
    ethers.parseEther("100"),
    ethers.parseEther("100")
  );

  // Print addresses you’ll need later
  console.log("== DEPLOY SUMMARY ==");
  console.log("Treasury EOA:", await treasuryEOA.getAddress());
  console.log("LPPTreasury:", await treasury.getAddress());
  console.log("LPPRebateVault:", await Vault.getAddress());
  console.log("LPPMintHook:", await Hook.getAddress());
  console.log("LPPFactory:", await Factory.getAddress());
  console.log("Asset:", await asset.getAddress());
  console.log("USDC:", await usdc.getAddress());
  console.log("Pool[0]:", poolAddr);
}

main().catch((e) => { console.error(e); process.exit(1); });