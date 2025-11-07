import { ethers } from "hardhat";
import { expect } from "./shared/expect";
import { deployCore } from "./helpers.ts";

describe("S5 — Revocation Guard", () => {
  it("Revoked Supplicator reverted", async () => {
    const { other, access, pool, router } = await deployCore();
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
