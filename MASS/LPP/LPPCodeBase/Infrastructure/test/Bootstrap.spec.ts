import { expect } from "./shared/expect";
import snapshotGasCost from "./shared/snapshotGasCost";
import { deployCore } from "./helpers";

describe("S1 — Bootstrap", () => {
  it("Factory + pools deployed & initialized", async () => {
    const everything = await deployCore();
    await snapshotGasCost(everything.factory);
    expect(await everything.pool.reserveAsset()).to.be.greaterThan(0n);
    expect(await everything.pool.reserveUsdc()).to.be.greaterThan(0n);
  });
});
