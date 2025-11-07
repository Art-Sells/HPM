// test/helpers.ts
import hre from "hardhat";
const { ethers } = hre;

import type {
  LPPAccessManager,
  LPPTreasury,
  LPPRebateVault,
  LPPMintHook,
  LPPRouter,
  LPPFactory,
  LPPPool,
  TestToken,
} from "../typechain-types";

export interface DeployCoreResult {
  deployer: any;
  other: any;
  access: LPPAccessManager;
  treasury: LPPTreasury;
  vault: LPPRebateVault;
  hook: LPPMintHook;
  router: LPPRouter;
  factory: LPPFactory;
  asset: TestToken;
  usdc: TestToken;
  pool: LPPPool;
}

export async function deployCore(): Promise<DeployCoreResult> {
  const [deployer, other] = await ethers.getSigners();

  // Access
  const Access = await ethers.getContractFactory("LPPAccessManager");
  const access = (await Access.deploy()) as unknown as LPPAccessManager;
  await access.waitForDeployment();

  // Treasury
  const Treasury = await ethers.getContractFactory("LPPTreasury");
  const treasury = (await Treasury.deploy(
    deployer.address,
    deployer.address
  )) as unknown as LPPTreasury;
  await treasury.waitForDeployment();

  // Vault
  const Vault = await ethers.getContractFactory("LPPRebateVault");
  const vault = (await Vault.deploy()) as unknown as LPPRebateVault;
  await vault.waitForDeployment();

  // Hook
  const Hook = await ethers.getContractFactory("LPPMintHook");
  const hook = (await Hook.deploy(
    await treasury.getAddress(),
    await vault.getAddress()
  )) as unknown as LPPMintHook;
  await hook.waitForDeployment();

  // Router
  const Router = await ethers.getContractFactory("LPPRouter");
  const router = (await Router.deploy(
    await access.getAddress()
  )) as unknown as LPPRouter;
  await router.waitForDeployment();

  // Factory (treasury-only)
  const Factory = await ethers.getContractFactory("LPPFactory");
  const factory = (await Factory.deploy(
    await treasury.getAddress()
  )) as unknown as LPPFactory;
  await factory.waitForDeployment();

  // Tokens
  const Token = await ethers.getContractFactory("TestToken");
  const asset = (await Token.deploy("Asset", "ASSET")) as unknown as TestToken;
  const usdc  = (await Token.deploy("USD Coin", "USDC")) as unknown as TestToken;
  await asset.waitForDeployment();
  await usdc.waitForDeployment();

  // fund deployer for bootstrap
  await asset.mint(deployer.address, ethers.parseEther("1000"));
  await usdc.mint(deployer.address,  ethers.parseEther("1000"));

  // create pool + set hook (treasury-only)
  await factory.connect(deployer).createPool(await asset.getAddress(), await usdc.getAddress());
  const poolAddr = (await factory.getPools())[0];

  const pool = (await ethers.getContractAt("LPPPool", poolAddr, deployer)) as unknown as LPPPool;

  await factory.connect(deployer).setPoolHook(poolAddr, await hook.getAddress());

  // bootstrap via Hook (treasury-only)
  await hook.connect(deployer).bootstrap(
    poolAddr,
    ethers.parseEther("100"),
    ethers.parseEther("100")
  );

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