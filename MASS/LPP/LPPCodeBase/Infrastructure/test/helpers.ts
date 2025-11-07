// test/helpers.ts
import { ethers } from "hardhat";
// import type { LPPAccessManager, LPPTreasury, LPPRebateVault, LPPMintHook, LPPRouter, LPPFactory, LPPPool, TestToken } from "../typechain-types";

export async function deployCore() {
  const [deployer, other] = await ethers.getSigners();

  // --- Access
  const Access = await ethers.getContractFactory("LPPAccessManager");
  const access = await Access.deploy();
  await access.waitForDeployment();

  // --- Treasury
  const TreasuryC = await ethers.getContractFactory("LPPTreasury");
  const treasury = await TreasuryC.deploy(deployer.address, deployer.address);
  await treasury.waitForDeployment();

  // --- Vault
  const Vault = await ethers.getContractFactory("LPPRebateVault");
  const vault = await Vault.deploy();
  await vault.waitForDeployment();

  // --- Hook
  const Hook = await ethers.getContractFactory("LPPMintHook");
  const hook = await Hook.deploy(await treasury.getAddress(), await vault.getAddress());
  await hook.waitForDeployment();

  // --- Router
  const Router = await ethers.getContractFactory("LPPRouter");
  const router = await Router.deploy(await access.getAddress());
  await router.waitForDeployment();

  // --- Factory (treasury-only factory)
  const Factory = await ethers.getContractFactory("LPPFactory");
  const factory = await Factory.deploy(await treasury.getAddress()); // constructor(treasury)
  await factory.waitForDeployment();

  // --- Tokens
  const Token = await ethers.getContractFactory("TestToken");
  const asset = await Token.deploy("Asset", "ASSET");
  const usdc  = await Token.deploy("USD Coin", "USDC");
  await asset.waitForDeployment();
  await usdc.waitForDeployment();

  // fund deployer for bootstrap
  await asset.mint(deployer.address, ethers.parseEther("1000"));
  await usdc.mint(deployer.address,  ethers.parseEther("1000"));

  // treasury-only create + hook wire
  await factory.connect(deployer).createPool(await asset.getAddress(), await usdc.getAddress());
  const poolAddr = (await factory.getPools())[0];
  const pool = await ethers.getContractAt("LPPPool", poolAddr);

  await factory.connect(deployer).setPoolHook(poolAddr, await hook.getAddress());

  // treasury-only bootstrap via Hook
  await hook.connect(deployer).bootstrap(
    poolAddr,
    ethers.parseEther("100"),
    ethers.parseEther("100")
  );

  // return EVERYTHING tests may need
  return {
    deployer,
    other,
    access,
    treasury,
    vault,
    hook,
    router,
    factory,
    asset,
    usdc,
    pool,
  };
}