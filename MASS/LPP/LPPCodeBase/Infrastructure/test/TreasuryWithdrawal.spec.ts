// test/TreasuryWithdrawal.spec.ts
import hre from "hardhat";
const { ethers, network } = hre;

import { expect } from "./shared/expect.ts";
import { deployCore } from "./helpers.ts";

const IERC20_FQN = "contracts/external/IERC20.sol:IERC20";

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

async function bal(token: any, who: string) {
  return BigInt((await token.balanceOf(who)).toString());
}

function near(x: bigint, y: bigint, msg?: string) {
  expect((x > y ? x - y : y - x), msg ?? "near").to.be.lte(1n);
}

/** Pulls live contracts/addresses we need from env (no manual ABIs). */
async function getInfra(env: any) {
  const { hook, pool, treasury, vault } = env;

  const assetAddr = await pool.asset();
  const usdcAddr  = await pool.usdc();

  const asset = await ethers.getContractAt(IERC20_FQN, assetAddr);
  const usdc  = await ethers.getContractAt(IERC20_FQN, usdcAddr);

  const treasuryAddr = treasury.target ?? (await treasury.getAddress());
  const vaultAddr    = vault.target ?? (await vault.getAddress());

  const tres = await ethers.getContractAt("LPPTreasury", treasuryAddr);

  const assetReceiver = await tres.assetRetentionReceiver();
  const usdcReceiver  = await tres.usdcRetentionReceiver();

  return {
    asset,
    usdc,
    treasury: tres,
    treasuryAddr,
    rebateVaultAddr: vaultAddr,
    assetReceiver,
    usdcReceiver,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Specs
 * ──────────────────────────────────────────────────────────────────────────── */

describe("Treasury — withdrawals, routing, and races", () => {
  it("Retention & Rebate routing after mintWithRebate (T1 ≈ 5%)", async () => {
    const env = await deployCore();
    const { deployer, hook, pool } = env;
    const {
      asset, usdc, rebateVaultAddr, assetReceiver, usdcReceiver
    } = await getInfra(env);

    // Seed pool (100/100)
    await (await hook.mintWithRebate({
      pool: await pool.getAddress(),
      to: await deployer.getAddress(),
      amountAssetDesired: ethers.parseEther("100"),
      amountUsdcDesired:  ethers.parseEther("100"),
      data: "0x",
    })).wait();

    // T1-sized deposit
    const depA = ethers.parseEther("5");
    const depU = ethers.parseEther("5");

    const a0V = await bal(asset, rebateVaultAddr);
    const u0V = await bal(usdc,  rebateVaultAddr);
    const a0T = await bal(asset, assetReceiver);
    const u0T = await bal(usdc,  usdcReceiver);

    // Fund caller & approve hook
    await (await env.asset.connect(deployer).mint(await deployer.getAddress(), depA)).wait();
    await (await env.usdc.connect(deployer).mint(await deployer.getAddress(), depU)).wait();

    await (await env.asset.connect(deployer).approve(await hook.getAddress(), ethers.MaxUint256)).wait();
    await (await env.usdc.connect(deployer).approve(await hook.getAddress(),  ethers.MaxUint256)).wait();

    await (await hook.mintWithRebate({
      pool: await pool.getAddress(),
      to: await deployer.getAddress(),
      amountAssetDesired: depA,
      amountUsdcDesired:  depU,
      data: "0x",
    })).wait();

    // T1 policy
    const rebateBps    = 100n; // 1.0%
    const retentionBps =  50n; // 0.5%

    const a1V = await bal(asset, rebateVaultAddr);
    const u1V = await bal(usdc,  rebateVaultAddr);
    const a1T = await bal(asset, assetReceiver);
    const u1T = await bal(usdc,  usdcReceiver);

    const rebateAExp = (BigInt(depA) * rebateBps)    / 10000n;
    const rebateUExp = (BigInt(depU) * rebateBps)    / 10000n;
    const keepAExp   = (BigInt(depA) * retentionBps) / 10000n;
    const keepUExp   = (BigInt(depU) * retentionBps) / 10000n;

    near(a1V - a0V, rebateAExp, "rebate vault asset");
    near(u1V - u0V, rebateUExp, "rebate vault usdc");
    near(a1T - a0T, keepAExp,   "treasury(asset) receiver");
    near(u1T - u0T, keepUExp,   "treasury(usdc) receiver");

    expect({
      dep: { a: depA.toString(), u: depU.toString() },
      rebateDelta:    { a: (a1V - a0V).toString(), u: (u1V - u0V).toString() },
      retentionDelta: { a: (a1T - a0T).toString(), u: (u1T - u0T).toString() },
      policy: { rebateBps: rebateBps.toString(), retentionBps: retentionBps.toString() }
    }).to.matchSnapshot("treasury-routing — rebate+retention T1");
  });

  it("Owner can withdraw stray ERC20 from Treasury to arbitrary recipient", async () => {
    const env = await deployCore();
    const { deployer } = env;
    const { asset, treasury, treasuryAddr } = await getInfra(env);

    // Simulate stray tokens stuck in Treasury
    const amt = ethers.parseEther("3");
    await (await env.asset.connect(deployer).mint(treasuryAddr, amt)).wait();

    const r0 = await bal(asset, treasuryAddr);
    expect(r0).to.be.gte(BigInt(amt));

    const recipient = await (await ethers.getSigners())[2].getAddress();
    const rec0 = await bal(asset, recipient);

    // Withdraw via owner
    await (await treasury
      .connect(deployer)
      .withdrawERC20(await asset.getAddress(), recipient, amt)
    ).wait();

    const r1   = await bal(asset, treasuryAddr);
    const rec1 = await bal(asset, recipient);

    expect(r0 - r1).to.equal(BigInt(amt));
    expect(rec1 - rec0).to.equal(BigInt(amt));

    expect({
      treasuryBefore: r0.toString(),
      treasuryAfter:  r1.toString(),
      recipientGain:  (rec1 - rec0).toString(),
    }).to.matchSnapshot("treasury-withdraw — owner recovery");
  });

  it("Rotation race (same block): old Treasury loses rights, new Treasury gains rights", async () => {
    const env = await deployCore();
    const { deployer, factory, treasury } = env;

    // Deploy a fresh Treasury (receivers arbitrary)
    const Treasury = await ethers.getContractFactory("LPPTreasury", deployer);
    const newTres  = await Treasury.deploy(
      await deployer.getAddress(),
      await deployer.getAddress()
    );
    await newTres.waitForDeployment();

    const factoryAddr = await factory.getAddress();
    const oldTresAddr = treasury.target ?? (await treasury.getAddress());
    const oldTres     = await ethers.getContractAt("LPPTreasury", oldTresAddr);

    const dummyA = await (await ethers.getSigners())[3].getAddress();
    const dummyU = await (await ethers.getSigners())[4].getAddress();

    // Same-block scheduling
    await network.provider.send("evm_setAutomine", [false]);

    const rotateTx = await oldTres
      .connect(deployer)
      .rotateFactoryTreasury(factoryAddr, await newTres.getAddress());

    // This call is queued *before* rotation mines, but mined together;
    // Factory.onlyTreasury should reject it after the rotation applies.
    const oldCreateTx = await oldTres
      .connect(deployer)
      .createPoolViaTreasury(factoryAddr, dummyA, dummyU);

    await network.provider.send("evm_mine");
    await network.provider.send("evm_setAutomine", [true]);

    // Rotation should finalize
    await expect(rotateTx).to.not.be.reverted;

    // Old create should fail in its receipt
    const oldReceipt = await oldCreateTx.wait().catch((e: any) => e);
    expect(String(oldReceipt)).to.match(/revert|only|treas/i);

    // New treasury can create
    const newTresIface = await ethers.getContractAt("LPPTreasury", await newTres.getAddress());
    await expect(
      newTresIface.createPoolViaTreasury(factoryAddr, dummyA, dummyU)
    ).to.not.be.reverted;
  });

  it("Hook wiring race: first setPoolHookViaTreasury wins; second attempt reverts", async () => {
    const env = await deployCore();
    const { deployer, factory, treasury, pool, vault } = env;

    const treasuryAddr   = treasury.target ?? (await treasury.getAddress());
    const rebateVaultAddr = vault.target ?? (await vault.getAddress());

    // Deploy two distinct hooks; only first should stick
    const Hook = await ethers.getContractFactory("LPPMintHook", deployer);
    const hook1 = await Hook.deploy(treasuryAddr, rebateVaultAddr);
    const hook2 = await Hook.deploy(treasuryAddr, rebateVaultAddr);
    await hook1.waitForDeployment();
    await hook2.waitForDeployment();

    const tres = await ethers.getContractAt("LPPTreasury", treasuryAddr);

    await expect(
      tres.connect(deployer).setPoolHookViaTreasury(
        await factory.getAddress(),
        await pool.getAddress(),
        await hook1.getAddress()
      )
    ).to.not.be.reverted;

    await expect(
      tres.connect(deployer).setPoolHookViaTreasury(
        await factory.getAddress(),
        await pool.getAddress(),
        await hook2.getAddress()
      )
    ).to.be.reverted;

    // Optional: peek wired hook if Factory exposes poolHook(pool)
    let wired: string | null = null;
    try {
      const fact = await ethers.getContractAt("LPPFactory", await factory.getAddress());
      // @ts-ignore — only if ABI includes poolHook
      wired = await fact.poolHook(await pool.getAddress());
    } catch {
      // ignore if not exposed
    }

    expect({
      first: await hook1.getAddress(),
      second: await hook2.getAddress(),
      wired: wired ?? "(unreadable via factory ABI; assumed hook1)"
    }).to.matchSnapshot("hook-wiring — only-first-succeeds");
  });
});