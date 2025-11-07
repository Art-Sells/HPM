import { expect } from "./shared/expect";
import { ethers } from "hardhat";
import { deployCore } from "./helpers";

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

  it("Unauthorized caller reverts", async () => {
    const { other, router, pool } = await deployCore();
    await expect(router.connect(other).supplicate({
      pool: await pool.getAddress(),
      assetToUsdc: true,
      amountIn: ethers.parseEther("1"),
      minAmountOut: 0,
      to: other.address
    })).to.be.revertedWith("not permitted");
  });
});
