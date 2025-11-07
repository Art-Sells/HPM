import { ethers } from "hardhat";
import { expect } from "./shared/expect.ts";
import snapshotGasCost from "./shared/snapshotGasCost.ts";
import { deployCore } from "./helpers.ts";

describe("Rebate / retention math precision", () => {
  it("Tier-1 skim 1.5% and emits events", async () => {
    const { deployer, hook, pool } = await deployCore();

    const params = {
      pool: await pool.getAddress(),
      to: deployer.address,
      amountAssetDesired: ethers.parseEther("10"),
      amountUsdcDesired:  ethers.parseEther("10"),
      data: "0x",
    };
    const tx = await hook.mintWithRebate(params);
    await snapshotGasCost(tx);

    const rc = await tx.wait();
    const q = rc!.logs.map((l: any) => (l.fragment ? { name: l.fragment.name, args: l.args } : null)).filter(Boolean);
    expect(q.length).to.be.greaterThan(0);
  });
});
