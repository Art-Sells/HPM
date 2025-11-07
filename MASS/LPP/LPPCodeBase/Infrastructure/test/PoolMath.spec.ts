import { expect } from "./shared/expect";
import { ethers } from "hardhat";
import { deployCore } from "./helpers";

describe("Pool math integrity", () => {
  it("reserves update correctly on mint/supplicate", async () => {
    const { deployer, hook, pool, router } = await deployCore();

    const beforeA = await pool.reserveAsset();
    const beforeU = await pool.reserveUsdc();

    await (await hook.mintWithRebate({
      pool: await pool.getAddress(),
      to: deployer.address,
      amountAssetDesired: ethers.parseEther("5"),
      amountUsdcDesired:  ethers.parseEther("5"),
      data: "0x"
    })).wait();

    const midA = await pool.reserveAsset();
    const midU = await pool.reserveUsdc();
    expect(midA).to.be.gt(beforeA);
    expect(midU).to.be.gt(beforeU);

    await (await router.supplicate({
      pool: await pool.getAddress(),
      assetToUsdc: true,
      amountIn: ethers.parseEther("1"),
      minAmountOut: 0,
      to: deployer.address
    })).wait();

    const afterA = await pool.reserveAsset();
    const afterU = await pool.reserveUsdc();
    expect(afterA).to.be.gt(midA);
    expect(afterU).to.be.lt(midU);
  });
});
