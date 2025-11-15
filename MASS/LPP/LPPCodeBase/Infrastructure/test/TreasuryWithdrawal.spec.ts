// // Treasury can withdraw all funds from pools (to stop test)
// and Treasury (and only treasury) can change the fees and amount
// it takes from fees





// test/TreasuryWithdrawal.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import { deployCore } from "./helpers.ts";

const IERC20_FQN = "contracts/external/IERC20.sol:IERC20";

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

async function bal(token: any, who: string) {
  return BigInt((await token.balanceOf(who)).toString());
}

/* ────────────────────────────────────────────────────────────────────────────
 * Specs — ONLY withdrawERC20 behaviors
 * ──────────────────────────────────────────────────────────────────────────── */

describe("LPPTreasury — withdrawERC20 only", () => {
  it("owner can withdraw ERC20 to an arbitrary recipient", async () => {
    const env = await deployCore();
    const { deployer, treasury, asset } = env;

    const treasuryAddr = (treasury as any).target ?? (await treasury.getAddress());
    const token = await ethers.getContractAt(IERC20_FQN, await asset.getAddress());

    // seed treasury with token
    const amt = ethers.parseEther("3");
    await (await env.asset.mint(treasuryAddr, amt)).wait();

    const [ , , recipientSigner ] = await ethers.getSigners();
    const recipient = await recipientSigner.getAddress();

    const t0 = await bal(token, treasuryAddr);
    const r0 = await bal(token, recipient);

    await (
      await treasury
        .connect(deployer)
        .withdrawERC20(await token.getAddress(), recipient, amt)
    ).wait();

    const t1 = await bal(token, treasuryAddr);
    const r1 = await bal(token, recipient);

    expect(t0 - t1).to.equal(BigInt(amt));
    expect(r1 - r0).to.equal(BigInt(amt));

    expect({
      token: await token.getAddress(),
      treasuryBefore: t0.toString(),
      treasuryAfter:  t1.toString(),
      recipientBefore: r0.toString(),
      recipientAfter:  r1.toString(),
      withdrawn: amt.toString(),
    }).to.matchSnapshot("treasury-withdraw-success");
  });

  it("reverts for non-owner caller (onlyOwner)", async () => {
    const env = await deployCore();
    const { other, treasury, asset } = env;

    const treasuryAddr = (treasury as any).target ?? (await treasury.getAddress());
    const token = await ethers.getContractAt(IERC20_FQN, await asset.getAddress());

    // give treasury some funds
    const amt = ethers.parseEther("1");
    await (await env.asset.mint(treasuryAddr, amt)).wait();

    const recipient = (await ethers.getSigners())[3].address;

    await expect(
      treasury
        .connect(other)
        .withdrawERC20(await token.getAddress(), recipient, amt)
    ).to.be.revertedWith("not owner");
  });

  it("reverts on zero recipient", async () => {
    const env = await deployCore();
    const { deployer, treasury, asset } = env;

    const token = await ethers.getContractAt(IERC20_FQN, await asset.getAddress());
    const amt = ethers.parseEther("1");

    await expect(
      treasury
        .connect(deployer)
        .withdrawERC20(await token.getAddress(), ethers.ZeroAddress, amt)
    ).to.be.revertedWith("zero to");
  });

  it("reverts on zero amount", async () => {
    const env = await deployCore();
    const { deployer, treasury, asset } = env;

    const token = await ethers.getContractAt(IERC20_FQN, await asset.getAddress());

    await expect(
      treasury
        .connect(deployer)
        .withdrawERC20(await token.getAddress(), (await ethers.getSigners())[4].address, 0)
    ).to.be.revertedWith("zero amount");
  });

  it("reverts when treasury balance is insufficient", async () => {
    const env = await deployCore();
    const { deployer, treasury, asset } = env;

    const treasuryAddr = (treasury as any).target ?? (await treasury.getAddress());
    const token = await ethers.getContractAt(IERC20_FQN, await asset.getAddress());

    // ensure treasury has less than amt
    const current = await bal(token, treasuryAddr);
    const amt = current + 1n;

    await expect(
      treasury
        .connect(deployer)
        .withdrawERC20(await token.getAddress(), (await ethers.getSigners())[5].address, amt)
    ).to.be.revertedWith("insufficient");
  });
});



