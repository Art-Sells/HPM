import hre from "hardhat";
const { ethers, network } = hre;
import { expect } from "./shared/expect.ts";

/*─────────────────────────────────────────────────────────────────────────────*
 * Helpers
 *─────────────────────────────────────────────────────────────────────────────*/

async function increaseTime(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

function humanizeSeconds(sec: bigint | number) {
  const s = typeof sec === "bigint" ? Number(sec) : sec;
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  return `${days} days ${hours} hours ${mins} mins`;
}

function humanizeSchedule(arr: bigint[] | any[]) {
  return arr.map((x: any) => {
    const bps = Number(x);
    return { bps: bps.toString(), percent: `${bps / 100}%` };
  });
}

/** Deploy Vesting + Vault + ERC20s */
async function deployVestingWithVault(epochSecsOverride?: number) {
  const [deployer] = await ethers.getSigners();
  const ERC20 = await ethers.getContractFactory("TestERC20");
  const asset = await ERC20.deploy("ASSET", "AST", deployer.address);
  const usdc = await ERC20.deploy("USDC", "USDC", deployer.address);
  await asset.waitForDeployment();
  await usdc.waitForDeployment();

  const VaultF = await ethers.getContractFactory("LPPRebateVault");
  const vault = await VaultF.deploy();
  await vault.waitForDeployment();

  const VestingF = await ethers.getContractFactory("LPPVesting");
  const epochSecs = epochSecsOverride ?? 7 * 24 * 60 * 60; // default 1 week
  const startTime = Math.floor(Date.now() / 1000);
  const schedule = [2500, 2500, 2500, 2500];

  console.log("🧩 Deploying LPPVesting with:", {
    treasury: deployer.address,
    vault: await vault.getAddress(),
    epochSecs,
    startTime,
    schedule,
  });

  const vesting = await VestingF.deploy(
    deployer.address,
    await vault.getAddress(),
    epochSecs,
    startTime,
    schedule
  );
  await vesting.waitForDeployment();

  return { vesting, vault, asset, usdc, deployer };
}

/*─────────────────────────────────────────────────────────────────────────────*
 * Tests
 *─────────────────────────────────────────────────────────────────────────────*/

describe("Vesting — epochs, percentages, balances, and access control", () => {
  let vesting: any, vault: any, asset: any, usdc: any, deployer: any;

  before(async () => {
    const deployed = await deployVestingWithVault();
    ({ vesting, vault, asset, usdc, deployer } = deployed);
  });

  /*─────────────────────────────── 01 — Epoch configuration ───────────────────────────────*/
  describe("01 — Epoch configuration", () => {
    it("reports epoch length in seconds and human form, increments correctly", async function () {
      const epochSecs = BigInt(await vesting.epochSeconds());
      const startEpoch = BigInt(await vesting.currentEpoch());
      const human = humanizeSeconds(epochSecs);

      await increaseTime(Number(epochSecs) - 2);
      const beforeBoundary = BigInt(await vesting.currentEpoch());
      await increaseTime(3);
      const afterBoundary = BigInt(await vesting.currentEpoch());

      expect({
        epochSeconds: `${epochSecs.toString()} (${human})`,
        before: beforeBoundary.toString(),
        after: afterBoundary.toString(),
        delta: (afterBoundary - startEpoch).toString(),
      }).to.matchSnapshot("vesting—epoch-increment-human");
    });
  });

  /*─────────────────────────────── 02 — Schedule percentages ───────────────────────────────*/
  describe("02 — Schedule percentages", () => {
    it("returns schedule array that sums to ≤10000 bps (with human breakdown)", async () => {
      const sched = await vesting.getSchedule();
      const sum = sched.reduce((a: bigint, b: any) => a + BigInt(b.toString()), 0n);
      const humanSchedule = humanizeSchedule(sched);

      expect({
        schedule: humanSchedule,
        sumBps: sum.toString(),
        sumPercent: `${Number(sum) / 100}%`,
      }).to.matchSnapshot("vesting—schedule-bps-human");
    });
  });

  /*─────────────────────────────── 03 — Early withdrawal prevention ────────────────────────*/
  describe("03 — Early withdrawal prevention", () => {
    it("blocks early claims from LPs, randoms, and treasury", async () => {
      const [_, lp, rando] = await ethers.getSigners();
      const actors = [lp, rando, deployer];
      const results: Record<string, string> = {};
      for (const a of actors) {
        try {
          await vesting.connect(a).claim();
          results[a.address] = "❌ succeeded (should revert)";
        } catch {
          results[a.address] = "✅ reverted";
        }
      }
      expect(results).to.matchSnapshot("vesting—early-claim-reverts-human");
    });
  });

  /*─────────────────────────────── 04 — Treasury-only mutation controls ─────────────────────────*/
  describe("04 — Treasury-only mutation controls", () => {
    it("shows old/new epochs and schedules in human terms", async () => {
      const oldEpoch = await vesting.epochSeconds();
      const oldSched = await vesting.getSchedule();

      const newEpoch = 2_000_000; // ~23 days
      const newSchedule = [3000, 3000, 2000, 2000];

      await (await vesting.connect(deployer).setEpochSeconds(newEpoch)).wait();
      await (await vesting.connect(deployer).setSchedule(newSchedule)).wait();

      const afterEpoch = await vesting.epochSeconds();
      const afterSched = await vesting.getSchedule();

      expect({
        oldEpochSeconds: `${oldEpoch.toString()} (${humanizeSeconds(oldEpoch)})`,
        newEpochSeconds: `${afterEpoch.toString()} (${humanizeSeconds(afterEpoch)})`,
        oldSchedule: humanizeSchedule(oldSched),
        newSchedule: humanizeSchedule(afterSched),
      }).to.matchSnapshot("vesting—treasury-human-full");
    });

    it("reverts if non-Treasury tries to mutate (accepts custom errors)", async () => {
      const [_, lp, rando] = await ethers.getSigners();
      const badSched = [1000, 2000, 3000, 4000];
      const reverts: Record<string, string[]> = {};

      for (const actor of [lp, rando]) {
        reverts[actor.address] = [];
        try {
          await vesting.connect(actor).setEpochSeconds(9999);
        } catch {
          reverts[actor.address].push("epochSeconds: reverted");
        }
        try {
          await vesting.connect(actor).setSchedule(badSched);
        } catch {
          reverts[actor.address].push("setSchedule: reverted");
        }
      }

      expect(reverts).to.matchSnapshot("vesting—non-treasury-reverts-human");
    });
  });
});