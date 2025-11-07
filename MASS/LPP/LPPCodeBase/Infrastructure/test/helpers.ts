// test/helpers.ts
import { ethers } from "hardhat";

export async function deployCore() {
  const [deployer, other] = await ethers.getSigners();

  const TreasuryC = await ethers.getContractFactory("LPPTreasury");
  const treasury = await TreasuryC.deploy(deployer.address, deployer.address);
  await treasury.waitForDeployment();

  const Vault = await (await ethers.getContractFactory("LPPRebateVault")).deploy();
  await Vault.waitForDeployment();

  const Hook = await ethers.getContractFactory("LPPMintHook");
  const hook = await Hook.deploy(await treasury.getAddress(), await Vault.getAddress());
  await hook.waitForDeployment();

  const Factory = await ethers.getContractFactory("LPPFactory");
  const factory = await Factory.deploy(deployer.address); // constructor(treasury)
  await factory.waitForDeployment();

  const Token = await ethers.getContractFactory("TestToken");
  const asset = await Token.deploy("Asset", "ASSET");
  const usdc  = await Token.deploy("USD Coin", "USDC");
  await asset.waitForDeployment();
  await usdc.waitForDeployment();

  // fund deployer with tokens (ERC20 TestToken.mint)
  await asset.mint(deployer.address, ethers.parseEther("1000"));
  await usdc.mint(deployer.address,  ethers.parseEther("1000"));

  // Treasury-only create
  await factory.connect(deployer).createPool(await asset.getAddress(), await usdc.getAddress());
  const poolAddr = (await factory.getPools())[0];
  const pool = await ethers.getContractAt("LPPPool", poolAddr);

  // Treasury-only setHook
  await factory.connect(deployer).setPoolHook(poolAddr, await hook.getAddress());

  // Treasury-only bootstrap via Hook (no public pool.mint)
  await hook.connect(deployer).bootstrap(
    poolAddr,
    ethers.parseEther("100"),
    ethers.parseEther("100")
  );

  return { deployer, other, treasury, factory, hook, asset, usdc, pool };
}