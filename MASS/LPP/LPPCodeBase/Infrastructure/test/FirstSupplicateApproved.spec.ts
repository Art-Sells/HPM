import { ethers } from "hardhat";
import { expect } from "./shared/expect";
import { deployCore } from "./helpers";

describe("S4 — First Supplicate (Approved)", () => {
  it("Treasury-approved address executes rebalance", async () => {
    const { other, access, pool, router } = await deployCore();
    await (await access.setApprovedSupplicator(other.address, true)).wait();

    await expect(router.connect(other).supplicate({
      pool: await pool.getAddress(),
      assetToUsdc: true,
      amountIn: ethers.parseEther("1"),
      minAmountOut: 0,
      to: other.address
    })).not.to.be.reverted;
  });
});
