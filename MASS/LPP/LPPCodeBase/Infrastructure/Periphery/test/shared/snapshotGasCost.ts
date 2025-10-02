import { expect } from "./expect.js";
import type {
  Contract,
  ContractTransactionResponse,
  TransactionResponse,
  TransactionReceipt,
} from "ethers";

type MaybeTx =
  | TransactionResponse
  | ContractTransactionResponse
  | Promise<TransactionResponse | ContractTransactionResponse>;

type MaybeContract = Contract | Promise<Contract>;
type MaybeReceipt = TransactionReceipt | Promise<TransactionReceipt>;
type MaybeBig = bigint | Promise<bigint> | number | string;

export default async function snapshotGasCost(
  x: MaybeTx | MaybeReceipt | MaybeBig | MaybeContract
): Promise<void> {
  const v: any = await x;

  // Deployed contract: try its deployment tx
  if (v && typeof v === "object" && typeof v.deploymentTransaction === "function") {
    const tx: ContractTransactionResponse | null = v.deploymentTransaction();
    if (tx) {
      const r = await tx.wait();
      expect(Number(r.gasUsed)).toMatchSnapshot();
      return;
    }
  }

  // Transaction-like (has wait)
  if (v && typeof v === "object" && typeof v.wait === "function") {
    const r: TransactionReceipt = await v.wait();
    expect(Number(r.gasUsed)).toMatchSnapshot();
    return;
  }

  // Bigint / number / string
  if (typeof v === "bigint") {
    expect(Number(v)).toMatchSnapshot();
    return;
  }
  if (typeof v === "number") {
    expect(v).toMatchSnapshot();
    return;
  }
  if (typeof v === "string") {
    expect(v).toMatchSnapshot();
    return;
  }

  throw new Error("snapshotGasCost: unsupported input");
}