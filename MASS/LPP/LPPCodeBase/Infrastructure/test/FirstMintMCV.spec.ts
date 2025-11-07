import { ethers } from "hardhat";
import { expect } from "./shared/expect";
import snapshotGasCost from "./shared/snapshotGasCost";
import { deployCore } from "./helpers";

describe("S2 — First Mint (MCV)", () => {
  it("Equal-value mint with Tier-1 rebate", async () => {
    const { deployer, hook, pool } = await deployCore();
    const tx = await hook.mintWithRebate({
      pool: await pool.getAddress(),
      to: deployer.address,
      amountAssetDesired: ethers.parseEther("10"),
      amountUsdcDesired:  ethers.parseEther("10"),
      data: "0x",
    });
    await snapshotGasCost(tx);
    const liq = await pool.liquidityOf(deployer.address);
    expect(liq).to.be.gt(0n);
  });
});
