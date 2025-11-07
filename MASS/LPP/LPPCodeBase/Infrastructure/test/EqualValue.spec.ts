import { ethers } from "hardhat";
import { expect } from "./shared/expect";
import { deployCore } from "./helpers";

describe("Equal-value enforcement", () => {
  it("passes within 10 bps tolerance", async () => {
    const { deployer, hook, pool } = await deployCore();
    const params = {
      pool: await pool.getAddress(),
      to: deployer.address,
      amountAssetDesired: ethers.parseEther("10"),
      amountUsdcDesired:  ethers.parseEther("10.009"),
      data: "0x",
    };
    await expect(hook.mintWithRebate(params)).not.to.be.reverted;
  });

  it("reverts outside 10 bps tolerance", async () => {
    const { deployer, hook, pool } = await deployCore();
    const params = {
      pool: await pool.getAddress(),
      to: deployer.address,
      amountAssetDesired: ethers.parseEther("10"),
      amountUsdcDesired:  ethers.parseEther("10.2"),
      data: "0x",
    };
    await expect(hook.mintWithRebate(params)).to.be.revertedWith("unequal value");
  });
});
