// test/helpers.ts
import hre from "hardhat";
const { ethers, network } = hre;

import type {
  LPPAccessManager,
  LPPTreasury,
  LPPRebateVault,
  LPPMintHook,
  LPPRouter,
  LPPFactory,
  LPPPool,
  TestERC20,
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
  pool: LPPPool;
  asset: TestERC20;
  usdc: TestERC20;
  assetAddr: string;
  usdcAddr: string;
}

export async function deployCore(): Promise<DeployCoreResult> {
  const [deployer, other] = await ethers.getSigners();

  // ── Access
  const Access = await ethers.getContractFactory("LPPAccessManager");
  const access = (await Access.deploy()) as unknown as LPPAccessManager;
  await access.waitForDeployment();

  // ── Treasury (owner = deployer)
  const Treasury = await ethers.getContractFactory("LPPTreasury");
  const treasury = (await Treasury.deploy(
    deployer.address,   // assetRetentionReceiver
    deployer.address    // usdcRetentionReceiver
  )) as unknown as LPPTreasury;
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();

  // ── Vault
  const Vault = await ethers.getContractFactory("LPPRebateVault");
  const vault = (await Vault.deploy()) as unknown as LPPRebateVault;
  await vault.waitForDeployment();

  // ── Hook
  const Hook = await ethers.getContractFactory("LPPMintHook");
  const hook = (await Hook.deploy(
    treasuryAddr,
    await vault.getAddress()
  )) as unknown as LPPMintHook;
  await hook.waitForDeployment();

  // ── Router
  const Router = await ethers.getContractFactory("LPPRouter");
  const router = (await Router.deploy(
    await access.getAddress()
  )) as unknown as LPPRouter;
  await router.waitForDeployment();

  // ── Factory (treasury-only)
  const Factory = await ethers.getContractFactory("LPPFactory");
  const factory = (await Factory.deploy(
    treasuryAddr
  )) as unknown as LPPFactory;
  await factory.waitForDeployment();

  // ── Real ERC20 tokens (3-arg constructor: name, symbol, minter)
  const ERC20 = await ethers.getContractFactory("TestERC20");
  const asset = (await ERC20.deploy("ASSET", "AST", deployer.address)) as unknown as TestERC20;
  const usdc  = (await ERC20.deploy("USDC",  "USDC", deployer.address)) as unknown as TestERC20;
  await asset.waitForDeployment();
  await usdc.waitForDeployment();

  const assetAddr = await asset.getAddress();
  const usdcAddr  = await usdc.getAddress();

  // ── Fund deployer & Treasury (minter = deployer)
  const BIG = ethers.parseEther("100000000"); // 100m
  await (await asset.mint(deployer.address, BIG)).wait();
  await (await usdc.mint(deployer.address,  BIG)).wait();
  await (await asset.mint(treasuryAddr,     BIG)).wait();
  await (await usdc.mint(treasuryAddr,      BIG)).wait();

  // ── Approve Hook to pull from deployer (for mintWithRebate during tests)
  await (await asset.approve(await hook.getAddress(), ethers.MaxUint256)).wait();
  await (await usdc.approve(await hook.getAddress(),  ethers.MaxUint256)).wait();

  // ── Allow-list tokens in Factory (required before createPool)
  await (await treasury.allowTokenViaTreasury(
    await factory.getAddress(), assetAddr, true
  )).wait();
  await (await treasury.allowTokenViaTreasury(
    await factory.getAddress(), usdcAddr, true
  )).wait();

  // ── Create pool via Treasury
  await (await treasury.createPoolViaTreasury(
    await factory.getAddress(),
    assetAddr,
    usdcAddr
  )).wait();

  const poolAddr = (await factory.getPools())[0];
  const pool = (await ethers.getContractAt("LPPPool", poolAddr, deployer)) as unknown as LPPPool;

  // ── Wire hook via Treasury
  await (await treasury.setPoolHookViaTreasury(
    await factory.getAddress(),
    poolAddr,
    await hook.getAddress()
  )).wait();

  // ── Impersonate Treasury to approve Hook (so bootstrap can pull from Treasury balances)
  await network.provider.send("hardhat_impersonateAccount", [treasuryAddr]);
  await network.provider.send("hardhat_setBalance", [treasuryAddr, "0x56BC75E2D63100000"]); // 100 ETH
  const treasurySigner = await ethers.getSigner(treasuryAddr);
  await (await asset.connect(treasurySigner).approve(await hook.getAddress(), ethers.MaxUint256)).wait();
  await (await usdc.connect(treasurySigner).approve(await hook.getAddress(),  ethers.MaxUint256)).wait();

  // ── Bootstrap via Treasury → Hook pulls from Treasury into Pool
  const BOOTSTRAP_ASSET = ethers.parseEther("100");
  const BOOTSTRAP_USDC  = ethers.parseEther("100");

  // use overload without offset (offset defaults to 0)
  const bootstrap4 = (treasury as any)["bootstrapViaTreasury(address,address,uint256,uint256)"];
  await (await bootstrap4(
    await hook.getAddress(),
    poolAddr,
    BOOTSTRAP_ASSET,
    BOOTSTRAP_USDC
  )).wait();

  // Optional: stop impersonation
  await network.provider.send("hardhat_stopImpersonatingAccount", [treasuryAddr]);

  return {
    deployer,
    other,
    access,
    treasury,
    vault,
    hook,
    router,
    factory,
    pool,
    asset,
    usdc,
    assetAddr,
    usdcAddr,
  };
}