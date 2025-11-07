import { ethers } from "hardhat";
import { expect } from "./shared/expect";
import { deployCore } from "./helpers";

describe("S6 — Quoter Validation", () => {
  it("Compare quoter output vs. execution", async () => {
    const { pool } = await deployCore();
    const Quoter = await ethers.getContractFactory("LPPSupplicationQuoter");
    const quoter = await Quoter.deploy();
    await quoter.waitForDeployment();

    const quoted = await quoter.quoteSupplication(await pool.getAddress(), true, ethers.parseEther("1"));
    const [amountOut] = await pool.quoteSupplication(true, ethers.parseEther("1"));

    expect(quoted.expectedAmountOut).to.equal(amountOut);
  });
});
