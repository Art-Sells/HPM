import { expect } from "chai";
import { ethers } from "hardhat";

describe("LPP v1 Smoke", function () {
  it("deploys, creates pool, mints via hook (equal value), and quotes supplication", async () => {
    const [deployer] = await ethers.getSigners();

    const Access = await ethers.getContractFactory("LPPAccessManager");
    const access = await Access.deploy();
    await access.waitForDeployment();

    const Treasury = await ethers.getContractFactory("LPPTreasury");
    const treasury = await Treasury.deploy(deployer.address, deployer.address);
    await treasury.waitForDeployment();

    const Vault = await ethers.getContractFactory("LPPRebateVault");
    const vault = await Vault.deploy();
    await vault.waitForDeployment();

    const MintHook = await ethers.getContractFactory("LPPMintHook");
    const hook = await MintHook.deploy(await treasury.getAddress(), await vault.getAddress());
    await hook.waitForDeployment();

    const Router = await ethers.getContractFactory("LPPRouter");
    const router = await Router.deploy(await access.getAddress());
    await router.waitForDeployment();

    const Factory = await ethers.getContractFactory("LPPFactory");
    const factory = await Factory.deploy();
    await factory.waitForDeployment();

    const Token = await ethers.getContractFactory("TestToken");
    const asset = await Token.deploy("Asset", "ASSET");
    const usdc  = await Token.deploy("USD Coin", "USDC");
    await asset.waitForDeployment();
    await usdc.waitForDeployment();

    // create a pool
    const tx = await factory.createPool(await asset.getAddress(), await usdc.getAddress());
    await tx.wait();
    const pools = await factory.getPools();
    const pool = await ethers.getContractAt("LPPPool", pools[0]);

    // seed initial reserves
    await asset.mint(deployer.address, ethers.parseEther("1000"));
    await usdc.mint(deployer.address, ethers.parseEther("1000"));
    await pool.mint(deployer.address, ethers.parseEther("100"), ethers.parseEther("100"));

    // mint via hook (equal value enforced)
    const params = {
      pool: await pool.getAddress(),
      to: deployer.address,
      amountAssetDesired: ethers.parseEther("10"),
      amountUsdcDesired:  ethers.parseEther("10"),
      data: "0x"
    };
    await (await hook.mintWithRebate(params)).wait();

    // LP-MCV check
    const liq = await pool.liquidityOf(deployer.address);
    expect(liq).to.be.gt(0n);

    // quoter
    const Quoter = await ethers.getContractFactory("LPPSupplicationQuoter");
    const quoter = await Quoter.deploy();
    await quoter.waitForDeployment();

    const q = await quoter.quoteSupplication(await pool.getAddress(), true, ethers.parseEther("1"));
    expect(q.expectedAmountOut).to.be.gt(0n);
    expect(q.liquidityBefore).to.be.gt(0n);
  });
});
