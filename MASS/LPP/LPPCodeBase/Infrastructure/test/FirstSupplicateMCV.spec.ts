import { ethers } from "hardhat";
import { expect } from "./shared/expect";
import { deployCore } from "./helpers";

describe("S3 — First Supplicate (MCV)", () => {
  it("LP-MCV executes rebalance", async () => {
    const { deployer, hook, pool, router } = await deployCore();
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
});
