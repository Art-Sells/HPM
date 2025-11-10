import { ethers } from "hardhat";
import { expect } from "./shared/expect.ts";
import { deployCore } from "./helpers.ts";

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
// if the address is not approved by treasury, it should fail, test this also...
// add snapshots and sqrtpricing (before and after) (from ABI)
// test the transferFroms from IERC20 tokens to see if it'll bypass our guards...