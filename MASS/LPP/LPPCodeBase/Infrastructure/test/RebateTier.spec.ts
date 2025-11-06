import { expect } from "chai";
import { ethers } from "hardhat";

describe("LPPMintHook Rebates/Retention", () => {
  it("applies tier & skims mint amounts; emits events", async () => {
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

    const Factory = await ethers.getContractFactory("LPPFactory");
    const factory = await Factory.deploy();
    await factory.waitForDeployment();

    const Token = await ethers.getContractFactory("TestToken");
    const asset = await Token.deploy("Asset", "ASSET");
    const usdc  = await Token.deploy("USD Coin", "USDC");
    await asset.waitForDeployment();
    await usdc.waitForDeployment();

    await factory.createPool(await asset.getAddress(), await usdc.getAddress());
    const pools = await factory.getPools();
    const pool = await ethers.getContractAt("LPPPool", pools[0]);

    // seed equal reserves so price=1
    await asset.mint(deployer.address, ethers.parseEther("1000"));
    await usdc.mint(deployer.address, ethers.parseEther("1000"));
    await pool.mint(deployer.address, ethers.parseEther("100"), ethers.parseEther("100"));

    // deposit 10/10 => TVL share ~ 20/(200+20)=9.09% => Tier 1 (rebate 1.0%, retention 0.5%)
    const params = {
      pool: await pool.getAddress(),
      to: deployer.address,
      amountAssetDesired: ethers.parseEther("10"),
      amountUsdcDesired:  ethers.parseEther("10"),
      data: "0x"
    };

    const tx = await hook.mintWithRebate(params);
    const rc = await tx.wait();

    // Find MCVQualified in logs
    const ev = rc?.logs.find(l => (l as any).fragment?.name === "MCVQualified");
    expect(ev).to.not.be.undefined;
    const args = (ev as any).args;
    expect(args.tier).to.equal(1);

    // Minted liquidity should be skimmed by 1.5% total
    // amount minted per token = desired * (1 - 0.015)
    const mintedLiq = await pool.liquidityOf(deployer.address);
    // existing was 200 (from initial 100/100), so new adds (20 * 0.985) = 19.7 ether
    // total should be > 219.6 and < 219.8 to allow integer truncation
    expect(mintedLiq).to.be.greaterThan(ethers.parseEther("219.6"));
    expect(mintedLiq).to.be.lessThan(ethers.parseEther("219.8"));
  });
});
