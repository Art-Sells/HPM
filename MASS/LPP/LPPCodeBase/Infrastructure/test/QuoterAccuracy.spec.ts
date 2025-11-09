import { expect } from "./shared/expect";
import { ethers } from "hardhat";
import { deployCore } from "./helpers.ts";

describe("Quoter accuracy", () => {
  it("quote aligns with execution within tolerance", async () => {
    const { pool } = await deployCore();
    const Quoter = await ethers.getContractFactory("LPPSupplicationQuoter");
    const quoter = await Quoter.deploy();
    await quoter.waitForDeployment();

    const q = await quoter.quoteSupplication(await pool.getAddress(), true, ethers.parseEther("1"));
    const [amountOut] = await pool.quoteSupplication(true, ethers.parseEther("1"));
    expect(q.expectedAmountOut).to.equal(amountOut);
  });
});
// add snapshots assetOut-in/usdcOur-in and sqrtpricing (from ABI)
