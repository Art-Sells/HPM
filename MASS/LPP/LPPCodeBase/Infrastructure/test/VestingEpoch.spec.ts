// test/VestingEpoch.spec.ts
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

function humanizeSchedule(arr: Array<bigint | number>) {
  return arr.map((x: bigint | number) => {
    const bps = typeof x === "bigint" ? Number(x) : x;
    return { bps: String(bps), percent: `${bps / 100}%` };
  });
}

function expandScheduleWithTime(epochSecs: bigint, schedule: Array<bigint | number>) {
  return schedule.map((bps, i) => ({
    epoch: i,
    durationSeconds: String(epochSecs),
    durationHuman: humanizeSeconds(epochSecs),
    bps: String(typeof bps === "bigint" ? Number(bps) : bps),
    percent: `${(typeof bps === "bigint" ? Number(bps) : bps) / 100}%`,
  }));
}

/** Deploy Vesting + Vault + ERC20s */
async function deployVestingWithVault(epochSecsOverride?: number) {
  const [deployer] = await ethers.getSigners();

  const ERC20 = await ethers.getContractFactory("TestERC20");
  const asset = await ERC20.deploy("ASSET", "AST", deployer.address);
  const usdc  = await ERC20.deploy("USDC",  "USDC", deployer.address);
  await asset.waitForDeployment();
  await usdc.waitForDeployment();

  const VaultF = await ethers.getContractFactory("LPPRebateVault");
  const vault = await VaultF.deploy();
  await vault.waitForDeployment();

  const VestingF = await ethers.getContractFactory("LPPVesting");
  const epochSecs = epochSecsOverride ?? 7 * 24 * 60 * 60; // 1 week default
  const startTime = Math.floor(Date.now() / 1000);
  const schedule  = [2500, 2500, 2500, 2500];

  console.log("🧩 Deploying LPPVesting with:", {
    treasury: deployer.address,
    vault: await vault.getAddress(),
    epochSecs,
    startTime,
    schedule,
  });

  const vesting = await VestingF.deploy(
    deployer.address,           // treasury
    await vault.getAddress(),   // vault
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

      await increaseTime(Number(epochSecs) - 2); // just before boundary
      const beforeBoundary = BigInt(await vesting.currentEpoch());

      await increaseTime(3); // cross boundary
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
      const raw = await vesting.getSchedule();
      const sched = raw.map((x: any) => BigInt(x.toString()));
      const sum = sched.reduce((a: bigint, b: bigint) => a + b, 0n);
      const human = humanizeSchedule(sched);

      expect({
        schedule: human,
        sumBps: sum.toString(),
        sumPercent: `${Number(sum) / 100}%`,
      }).to.matchSnapshot("vesting—schedule-bps-human");
    });

    it("returns expanded schedule with per-epoch human duration", async () => {
      const raw = await vesting.getSchedule();
      const sched = raw.map((x: any) => BigInt(x.toString()));
      const epochSecs = BigInt(await vesting.epochSeconds());
      const expanded = expandScheduleWithTime(epochSecs, sched);

      expect({
        epochSeconds: `${epochSecs} (${humanizeSeconds(epochSecs)})`,
        expanded,
      }).to.matchSnapshot("vesting—schedule-expanded-human");
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

  /*─────────────────────────────── 04 — Treasury-only mutation controls ────────────────────*/
  describe("04 — Treasury-only mutation controls", () => {
    it("shows old/new epochs and schedules in human terms", async () => {
      const oldEpoch = BigInt(await vesting.epochSeconds());
      const oldSchedRaw = await vesting.getSchedule();
      const oldSched = oldSchedRaw.map((x: any) => BigInt(x.toString()));

      const newEpoch = 2_000_000; // ~23 days
      const newSchedule = [3000, 3000, 2000, 2000];

      await (await vesting.connect(deployer).setEpochSeconds(newEpoch)).wait();
      await (await vesting.connect(deployer).setSchedule(newSchedule)).wait();

      const afterEpoch = BigInt(await vesting.epochSeconds());
      const afterSchedRaw = await vesting.getSchedule();
      const afterSched = afterSchedRaw.map((x: any) => BigInt(x.toString()));

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

  /*─────────────────────────────── 05 — Final payout after all epochs ──────────────────────*/
  describe("05 — LP-MCV payments after vesting completion", () => {
    it("releases full vested amount to LP-MCV after final epoch (with human snapshot)", async () => {
      const [deployer, lpMCV] = await ethers.getSigners();

      const amount = ethers.parseEther("100");
      const tokenAddr = await asset.getAddress();
      const vaultAddr = await vault.getAddress();
      const vestingAddr = await vesting.getAddress();

      // 1) Fund the vault so it can pay out
      await (await asset.mint(vaultAddr, amount)).wait();

      // 2) Impersonate the vault and approve the vesting contract to pull funds
      await network.provider.send("hardhat_impersonateAccount", [vaultAddr]);
      await network.provider.send("hardhat_setBalance", [vaultAddr, "0x56BC75E2D63100000"]); // 100 ETH
      const vaultSigner = await ethers.getSigner(vaultAddr);
      await (await asset.connect(vaultSigner).approve(vestingAddr, ethers.MaxUint256)).wait();

      // 3) Treasury grants LP-MCV a vesting position
      await (await vesting.connect(deployer).grant(lpMCV.address, tokenAddr, amount)).wait();

      // 4) Travel through all epochs
      const schedule = await vesting.getSchedule();
      const totalEpochs = Number(schedule.length);
      const epochSecs = Number(await vesting.epochSeconds());
      await increaseTime(epochSecs * totalEpochs);

      // 5) Claim & assert
      const b0 = await asset.balanceOf(lpMCV.address);
      await (await vesting.connect(lpMCV).claim()).wait();
      const b1 = await asset.balanceOf(lpMCV.address);

      expect(b1 - b0).to.equal(amount);

      // 6) Snapshot in human form
      expect({
        payer: vaultAddr,
        payee: lpMCV.address,
        token: tokenAddr,
        totalEpochs,
        epochSeconds: `${epochSecs} (${humanizeSeconds(epochSecs)})`,
        totalSeconds: `${epochSecs * totalEpochs} (${humanizeSeconds(epochSecs * totalEpochs)})`,
        vestedAmount: `${ethers.formatEther(amount)} tokens`,
        paidNow: `${ethers.formatEther(b1 - b0)} tokens`,
        allowanceGranted: "yes",
      }).to.matchSnapshot("vesting—final-payout-LP-MCV-human");

      // 7) Cleanup
      await network.provider.send("hardhat_stopImpersonatingAccount", [vaultAddr]);
    });
  });
});