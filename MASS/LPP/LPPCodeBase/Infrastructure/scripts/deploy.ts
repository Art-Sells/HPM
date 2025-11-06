import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const Access = await ethers.getContractFactory("LPPAccessManager");
  const access = await Access.deploy();
  await access.waitForDeployment();
  console.log("AccessManager:", await access.getAddress());

  const Treasury = await ethers.getContractFactory("LPPTreasury");
  const treasury = await Treasury.deploy(deployer.address, deployer.address);
  await treasury.waitForDeployment();
  console.log("Treasury:", await treasury.getAddress());

  const Vault = await ethers.getContractFactory("LPPRebateVault");
  const vault = await Vault.deploy();
  await vault.waitForDeployment();
  console.log("RebateVault:", await vault.getAddress());

  const MintHook = await ethers.getContractFactory("LPPMintHook");
  const hook = await MintHook.deploy(await treasury.getAddress(), await vault.getAddress());
  await hook.waitForDeployment();
  console.log("MintHook:", await hook.getAddress());

  const Router = await ethers.getContractFactory("LPPRouter");
  const router = await Router.deploy(await access.getAddress());
  await router.waitForDeployment();
  console.log("Router:", await router.getAddress());

  const Factory = await ethers.getContractFactory("LPPFactory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  console.log("Factory:", await factory.getAddress());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
