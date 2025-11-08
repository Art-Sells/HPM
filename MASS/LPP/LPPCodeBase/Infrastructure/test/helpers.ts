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
  assetAddr: string;
  usdcAddr: string;
}

/** Return two distinct, non-zero, EOA-looking addresses for token placeholders */
function dummyTokenPair(): { assetAddr: string; usdcAddr: string } {
  const a = ethers.Wallet.createRandom().address;
  let b = ethers.Wallet.createRandom().address;
  if (b.toLowerCase() === a.toLowerCase()) {
    b = ethers.Wallet.createRandom().address;
  }
  return { assetAddr: a, usdcAddr: b };
}

export async function deployCore(): Promise<DeployCoreResult> {
  const [deployer, other] = await ethers.getSigners();

  // Access
  const Access = await ethers.getContractFactory("LPPAccessManager");
  const access = (await Access.deploy()) as unknown as LPPAccessManager;
  await access.waitForDeployment();

  // Treasury (owner = deployer)
  const Treasury = await ethers.getContractFactory("LPPTreasury");
  const treasury = (await Treasury.deploy(deployer.address, deployer.address)) as unknown as LPPTreasury;
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

  // Dummy token addresses (no TestToken!)
  const { assetAddr, usdcAddr } = dummyTokenPair();

  // Treasury-only: create pool via Treasury forwarder
  await treasury.createPoolViaTreasury(
    await factory.getAddress(),
    assetAddr,
    usdcAddr
  );
  const poolAddr = (await factory.getPools())[0];
  const pool = (await ethers.getContractAt("LPPPool", poolAddr, deployer)) as unknown as LPPPool;

  // Treasury-only: wire hook via Treasury forwarder
  await treasury.setPoolHookViaTreasury(
    await factory.getAddress(),
    poolAddr,
    await hook.getAddress()
  );

  // Treasury-only: bootstrap via Treasury forwarder (no offset overload ambiguity here)
  const bootstrap4 = (treasury as any)["bootstrapViaTreasury(address,address,uint256,uint256)"];
  await bootstrap4(
    await hook.getAddress(),
    poolAddr,
    ethers.parseEther("100"),
    ethers.parseEther("100")
  );

  return { deployer, other, access, treasury, vault, hook, router, factory, pool, assetAddr, usdcAddr };
}