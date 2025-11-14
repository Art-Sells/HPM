// test/helpers.ts
import hre from "hardhat";
const { ethers, network } = hre;

import type {
  LPPAccessManager,
  LPPTreasury,
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

  // ──────────────────────────────────────────────
  // 1. Deploy Access Manager
  // ──────────────────────────────────────────────
  const Access = await ethers.getContractFactory("LPPAccessManager");
  const access = (await Access.deploy()) as LPPAccessManager;
  await access.waitForDeployment();

  // ──────────────────────────────────────────────
  // 2. Deploy Treasury (owner = deployer)
  // ──────────────────────────────────────────────
  const Treasury = await ethers.getContractFactory("LPPTreasury");
  const treasury = (await Treasury.deploy()) as LPPTreasury;
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();

  // ──────────────────────────────────────────────
  // 3. Deploy Router (accessManager, treasury)
  // ──────────────────────────────────────────────
  const Router = await ethers.getContractFactory("LPPRouter");
  const router = (await Router.deploy(
    await access.getAddress(),
    treasuryAddr
  )) as LPPRouter;
  await router.waitForDeployment();

  // ──────────────────────────────────────────────
  // 4. Deploy Factory (treasury)
  // ──────────────────────────────────────────────
  const Factory = await ethers.getContractFactory("LPPFactory");
  const factory = (await Factory.deploy(
    treasuryAddr
  )) as LPPFactory;
  await factory.waitForDeployment();

  // ──────────────────────────────────────────────
  // 5. Deploy TestERC20 tokens (3-arg constructor)
  // ──────────────────────────────────────────────
  const ERC20 = await ethers.getContractFactory("TestERC20");

  const asset = (await ERC20.deploy(
    "ASSET",
    "AST",
    deployer.address
  )) as TestERC20;

  const usdc = (await ERC20.deploy(
    "USDC",
    "USDC",
    deployer.address
  )) as TestERC20;

  await asset.waitForDeployment();
  await usdc.waitForDeployment();

  const assetAddr = await asset.getAddress();
  const usdcAddr  = await usdc.getAddress();

  // Mint deployer full supply for tests
  const BIG = ethers.parseEther("100000000");
  await (await asset.mint(deployer.address, BIG)).wait();
  await (await usdc.mint(deployer.address,  BIG)).wait();

  // ──────────────────────────────────────────────
  // 6. Allow-list asset + usdc (required before createPool)
  // ──────────────────────────────────────────────
  await (await treasury.allowTokenViaTreasury(
    await factory.getAddress(),
    assetAddr,
    true
  )).wait();

  await (await treasury.allowTokenViaTreasury(
    await factory.getAddress(),
    usdcAddr,
    true
  )).wait();

  // ──────────────────────────────────────────────
  // 7. Create initial pool via Treasury
  // ──────────────────────────────────────────────
  await (
    await treasury.createPoolViaTreasury(
      await factory.getAddress(),
      assetAddr,
      usdcAddr
    )
  ).wait();

  const pools = await factory.getPools();
  const poolAddr = pools[0];
  const pool = (await ethers.getContractAt("LPPPool", poolAddr)) as LPPPool;

  // ──────────────────────────────────────────────
  // 8. Fund Treasury with tokens (for bootstrap tests)
  // ──────────────────────────────────────────────
  await (await asset.mint(treasuryAddr, ethers.parseEther("1000"))).wait();
  await (await usdc.mint(treasuryAddr,  ethers.parseEther("1000"))).wait();

  return {
    deployer,
    other,
    access,
    treasury,
    router,
    factory,
    pool,
    asset,
    usdc,
    assetAddr,
    usdcAddr,
  };
}