import { expect } from "./expect.ts";

function toNumber(x: any): number {
  if (typeof x === "bigint") return Number(x);
  if (typeof x === "number") return x;
  if (x && typeof x.toString === "function") return Number(x.toString());
  return NaN;
}

export default async function snapshotGasCost(x: any): Promise<void> {
  const r = await x;

  // Deployed contract (ethers v6)
  if (r && typeof r.deploymentTransaction === "function") {
    const receipt = await r.deploymentTransaction().wait();
    if (!receipt) throw new Error("No deployment receipt");
    expect(toNumber(receipt.gasUsed)).toMatchSnapshot();
    return;
  }

  // TransactionResponse-like
  if (r && typeof r.wait === "function") {
    const receipt = await r.wait();
    if (!receipt) throw new Error("No tx receipt");
    expect(toNumber(receipt.gasUsed)).toMatchSnapshot();
    return;
  }

  // Raw gas value (bigint/number/BigNumber-like)
  const n = toNumber(r);
  if (!Number.isNaN(n)) {
    expect(n).toMatchSnapshot();
    return;
  }

  throw new Error("snapshotGasCost: unsupported value");
}