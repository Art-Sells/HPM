import { expect } from "./shared/expect.ts";
import { ethers } from "hardhat";
import { deployCore } from "./helpers.ts"; 

describe("Access gating", () => {
  it("LP-MCV can supplicate", async () => {
    const { deployer, hook, router, pool } = await deployCore();

    await (await hook.mintWithRebate({
      pool: await pool.getAddress(),
      to: deployer.address,
      amountAssetDesired: ethers.parseEther("5"),
      amountUsdcDesired:  ethers.parseEther("5"),
      data: "0x"
    })).wait();

    await expect(router.supplicate({
      pool: await pool.getAddress(),
      assetToUsdc: true,
      amountIn: ethers.parseEther("1"),
      minAmountOut: 0,
      to: deployer.address
    })).not.to.be.reverted;
  });

  it("Approved Supplicator can supplicate without LP", async () => {
    const { other, access, router, pool } = await deployCore();
    await (await access.setApprovedSupplicator(other.address, true)).wait();

    await expect(router.connect(other).supplicate({
      pool: await pool.getAddress(),
      assetToUsdc: true,
      amountIn: ethers.parseEther("1"),
      minAmountOut: 0,
      to: other.address
    })).not.to.be.reverted;
  });

  it("Unauthorized caller reverts (not LP-MCV and not Approved)", async () => {
    const { other, router, pool } = await deployCore();

    await expect(router.connect(other).supplicate({
      pool: await pool.getAddress(),
      assetToUsdc: true,
      amountIn: ethers.parseEther("1"),
      minAmountOut: 0,
      to: other.address
    })).to.be.revertedWith("not permitted");
  });

  //
  // ───────────────── Treasury-only authorizations ─────────────────
  //

  it("Treasury-only: createPool + setPoolHook", async () => {
    const { deployer, factory, hook } = await deployCore();

    // fresh tokens for a new pool
    const Token = await ethers.getContractFactory("TestToken");
    const asset2 = await Token.deploy("Asset2", "A2");
    const usdc2  = await Token.deploy("USD Coin 2", "USDC2");
    await asset2.waitForDeployment(); await usdc2.waitForDeployment();

    const [ , stranger ] = await ethers.getSigners();

    // stranger cannot create
    await expect(
      factory.connect(stranger).createPool(await asset2.getAddress(), await usdc2.getAddress())
    ).to.be.revertedWith("only treasury");

    // treasury can create
    await expect(
      factory.connect(deployer).createPool(await asset2.getAddress(), await usdc2.getAddress())
    ).to.not.be.reverted;

    const poolAddr = (await factory.getPools())[1];

    // stranger cannot wire hook
    await expect(
      factory.connect(stranger).setPoolHook(poolAddr, await hook.getAddress())
    ).to.be.revertedWith("only treasury");

    // treasury wires hook
    await expect(
      factory.connect(deployer).setPoolHook(poolAddr, await hook.getAddress())
    ).to.not.be.reverted;
  });

  it("Treasury-only: bootstrap via Hook; non-treasury reverts", async () => {
    const { deployer, other, hook, pool } = await deployCore();

    // non-treasury cannot bootstrap
    await expect(
      hook.connect(other).bootstrap(
        await pool.getAddress(),
        ethers.parseEther("1"),
        ethers.parseEther("1")
      )
    ).to.be.revertedWith("only treasury");

    // treasury can bootstrap (idempotency: calling twice should revert 'already init')
    await expect(
      hook.connect(deployer).bootstrap(
        await pool.getAddress(),
        ethers.parseEther("1"),
        ethers.parseEther("1")
      )
    ).to.be.revertedWith("already init"); // deployCore already bootstraps once
  });

  it("Non-hook cannot call pool.mintFromHook (only hook allowed)", async () => {
    const { other, pool } = await deployCore();

    await expect(
      (pool as any).connect(other).mintFromHook(
        other.address,
        ethers.parseEther("1"),
        ethers.parseEther("1")
      )
    ).to.be.revertedWith("only hook");
  });

  //
  // ───────────────── LP-MCV minting path vs Unauthorized ─────────────────
  //

  it("Any address can become LP-MCV via mintWithRebate (open LP-MCV), then supplicate", async () => {
    const { other, asset, usdc, hook, router, pool } = await deployCore();

    // fund 'other' to mint equal-value
    await asset.mint(other.address, ethers.parseEther("100"));
    await usdc.mint(other.address,  ethers.parseEther("100"));

    await expect(
      hook.connect(other).mintWithRebate({
        pool: await pool.getAddress(),
        to: other.address,
        amountAssetDesired: ethers.parseEther("10"),
        amountUsdcDesired:  ethers.parseEther("10"),
        data: "0x",
      })
    ).to.not.be.reverted;

    // now 'other' is LP-MCV and may supplicate
    await expect(
      router.connect(other).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0,
        to: other.address
      })
    ).to.not.be.reverted;
  });

  it("mintWithRebate enforces equal-value tolerance (skewed deposit reverts)", async () => {
    const { other, asset, usdc, hook, pool } = await deployCore();

    await asset.mint(other.address, ethers.parseEther("100"));
    await usdc.mint(other.address,  ethers.parseEther("100"));

    await expect(
      hook.connect(other).mintWithRebate({
        pool: await pool.getAddress(),
        to: other.address,
        amountAssetDesired: ethers.parseEther("10"),
        amountUsdcDesired:  ethers.parseEther("12"), // drift > 10 bps
        data: "0x",
      })
    ).to.be.revertedWith("unequal value");
  });
});