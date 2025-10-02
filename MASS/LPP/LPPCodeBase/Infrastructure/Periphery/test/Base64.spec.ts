import { ethers } from "hardhat";
import type { Contract } from "ethers";
import { base64Encode } from "./shared/base64.js";
import { expect } from "./shared/expect.js";
import { randomBytes } from "crypto";
import snapshotGasCost from "./shared/snapshotGasCost.js";

// minimal runtime type for the contract
type Base64Test = Contract & {
  encode(data: string): Promise<string>;
  getGasCostOfEncode(data: string): Promise<bigint>;
};

const stringToHex = (s: string) => `0x${Buffer.from(s, "utf8").toString("hex")}`;

describe("Base64", () => {
  let base64: Base64Test;

  before("deploy test contract", async () => {
    const F = await ethers.getContractFactory("Base64Test");
    const c = await F.deploy();
    await c.waitForDeployment();
    base64 = c as unknown as Base64Test;
  });

  describe("#encode", () => {
    it("is correct for empty bytes", async () => {
      expect(await base64.encode(stringToHex(""))).to.eq("");
    });

    for (const example of [
      "test string",
      "this is a test",
      "alphabet soup",
      "aLpHaBeT",
      "includes\nnewlines",
      "<some html>",
      "😀",
      "f",
      "fo",
      "foo",
      "foob",
      "fooba",
      "foobar",
      "this is a very long string that should cost a lot of gas to encode :)",
    ]) {
      it(`works for "${example}"`, async () => {
        expect(await base64.encode(stringToHex(example))).to.eq(base64Encode(example));
      });

      it(`gas cost of encode(${example})`, async () => {
        await snapshotGasCost(base64.getGasCostOfEncode(stringToHex(example)));
      });
    }

    describe("max size string (24kB)", () => {
      let str: string;
      before(() => {
        str = Array<null>(24 * 1024)
          .fill(null)
          .map((_, i) => String.fromCharCode(i % 1024))
          .join("");
      });
      it("correctness", async () => {
        expect(await base64.encode(stringToHex(str))).to.eq(base64Encode(str));
      });
      it("gas cost", async () => {
        await snapshotGasCost(base64.getGasCostOfEncode(stringToHex(str)));
      });
    });

    it("tiny fuzzing", async () => {
      const inputs: Buffer[] = [];
      for (let i = 0; i < 100; i++) inputs.push(randomBytes(Math.random() * 100));
      const results = await Promise.all(inputs.map((b) => base64.encode(`0x${b.toString("hex")}`)));
      for (let i = 0; i < inputs.length; i++) {
        expect(inputs[i].toString("base64")).to.eq(results[i]);
      }
    }).timeout(300_000);
  });
});