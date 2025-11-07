import { expect } from "./shared/expect";
import { ethers } from "hardhat";
import { deployCore } from "./helpers";

describe("Revocation enforcement", () => {
  it("revoked approved supplicator cannot call", async () => {
    const { other, access, router, pool } = await deployCore();
    await (await access.setApprovedSupplicator(other.address, true)).wait();
    await (await access.setApprovedSupplicator(other.address, false)).wait();

    await expect(router.connect(other).supplicate({
      pool: await pool.getAddress(),
      assetToUsdc: true,
      amountIn: ethers.parseEther("1"),
      minAmountOut: 0,
      to: other.address
    })).to.be.revertedWith("not permitted");
  });
});
