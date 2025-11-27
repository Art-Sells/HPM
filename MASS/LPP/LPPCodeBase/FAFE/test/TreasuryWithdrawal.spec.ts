// // Treasury can withdraw all funds from pools (to stop test)
// and Treasury (and only treasury) can change the fees and amount
// it takes from fees
// Treasury can also pause the router (swaps, supplications, etc.)


// test/TreasuryWithdrawal.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import { 
  deployCore, 
  runSupplicate, 
  runSwap, 
  approveSupplicator,
  bootstrapPool,
  wireLegacyOrbit,
  ensureNPools,
  approveMax,
  approveMaxMany,
  A,
  U
} from "./helpers.ts";

import type {
  FAFERouter,
  FAFETreasury,
  FAFEAccessManager,
  FAFEPool,
  TestERC20,
} from "../typechain-types/index.ts";

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

describe("FAFETreasury — withdrawERC20 only", () => {
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

/* ────────────────────────────────────────────────────────────────────────────
 * Specs — Router Pause functionality
 * ──────────────────────────────────────────────────────────────────────────── */

describe("FAFETreasury — Router Pause", () => {
  it("treasury owner can pause the router", async () => {
    const env = await deployCore();
    const { deployer, treasury, router } = env;

    // Initially not paused
    expect(await router.paused()).to.equal(false);

    // Treasury owner can pause via forwarder
    await (await treasury.connect(deployer).pauseRouterViaTreasury(await router.getAddress())).wait();

    expect(await router.paused()).to.equal(true);
  });

  it("treasury owner can unpause the router", async () => {
    const env = await deployCore();
    const { deployer, treasury, router } = env;

    // Pause first
    await (await treasury.connect(deployer).pauseRouterViaTreasury(await router.getAddress())).wait();
    expect(await router.paused()).to.equal(true);

    // Unpause
    await (await treasury.connect(deployer).unpauseRouterViaTreasury(await router.getAddress())).wait();

    expect(await router.paused()).to.equal(false);
  });

  it("treasury owner can toggle pause multiple times", async () => {
    const env = await deployCore();
    const { deployer, treasury, router } = env;

    expect(await router.paused()).to.equal(false);

    // Pause
    await (await treasury.connect(deployer).pauseRouterViaTreasury(await router.getAddress())).wait();
    expect(await router.paused()).to.equal(true);

    // Unpause
    await (await treasury.connect(deployer).unpauseRouterViaTreasury(await router.getAddress())).wait();
    expect(await router.paused()).to.equal(false);

    // Pause again
    await (await treasury.connect(deployer).pauseRouterViaTreasury(await router.getAddress())).wait();
    expect(await router.paused()).to.equal(true);
  });

  it("reverts when non-owner tries to pause", async () => {
    const env = await deployCore();
    const { other, treasury, router } = env;

    await expect(
      treasury
        .connect(other)
        .pauseRouterViaTreasury(await router.getAddress())
    ).to.be.revertedWith("not owner");
  });

  it("reverts when non-owner tries to unpause", async () => {
    const env = await deployCore();
    const { deployer, other, treasury, router } = env;

    // Pause first as owner
    await (await treasury.connect(deployer).pauseRouterViaTreasury(await router.getAddress())).wait();

    // Non-owner cannot unpause
    await expect(
      treasury
        .connect(other)
        .unpauseRouterViaTreasury(await router.getAddress())
    ).to.be.revertedWith("not owner");
  });

  it("reverts when non-treasury tries to call pause directly on router", async () => {
    const env = await deployCore();
    const { other, router } = env;

    await expect(
      router.connect(other).pause()
    ).to.be.revertedWith("not treasury");
  });

  it("reverts when non-treasury tries to call unpause directly on router", async () => {
    const env = await deployCore();
    const { deployer, other, treasury, router } = env;

    // Pause first via treasury
    await (await treasury.connect(deployer).pauseRouterViaTreasury(await router.getAddress())).wait();

    // Non-treasury cannot unpause directly
    await expect(
      router.connect(other).unpause()
    ).to.be.revertedWith("not treasury");
  });

  it("blocks supplicate when paused", async () => {
    const env = await deployCore();
    const { deployer, treasury, router, pool, asset, usdc, access, other } = env;

    // Bootstrap pool
    const poolAddr = await pool.getAddress();
    await bootstrapPool(treasury, poolAddr, asset, usdc, A, U, 0);

    // Approve supplicator
    await approveSupplicator(access, other.address, true);

    // Fund and approve
    const amountIn = ethers.parseEther("1");
    await (await asset.connect(deployer).mint(other.address, amountIn)).wait();
    await approveMax(asset, other, poolAddr);

    // Pause the router
    await (await treasury.connect(deployer).pauseRouterViaTreasury(await router.getAddress())).wait();

    // Supplicate should revert
    await expect(
      runSupplicate({
        router,
        caller: other,
        poolAddr,
        assetToUsdc: true,
        amountIn,
      })
    ).to.be.revertedWithCustomError(router, "RouterPaused");
  });

  it("allows supplicate when unpaused", async () => {
    const env = await deployCore();
    const { deployer, treasury, router, pool, asset, usdc, access, other } = env;

    // Bootstrap pool
    const poolAddr = await pool.getAddress();
    await bootstrapPool(treasury, poolAddr, asset, usdc, A, U, 0);

    // Approve supplicator
    await approveSupplicator(access, other.address, true);

    // Fund and approve
    const amountIn = ethers.parseEther("1");
    await (await asset.connect(deployer).mint(other.address, amountIn * 2n)).wait();
    await approveMax(asset, other, poolAddr);

    // Pause and unpause
    await (await treasury.connect(deployer).pauseRouterViaTreasury(await router.getAddress())).wait();
    await (await treasury.connect(deployer).unpauseRouterViaTreasury(await router.getAddress())).wait();

    // Supplicate should succeed
    await expect(
      runSupplicate({
        router,
        caller: other,
        poolAddr,
        assetToUsdc: true,
        amountIn,
      })
    ).to.not.be.reverted;
  });

  it("blocks swap when paused", async () => {
    const env = await deployCore();
    const { deployer, treasury, router, factory, asset, usdc, other } = env;

    // Setup orbit with 3 pools
    const pools = await ensureNPools(factory, treasury, await asset.getAddress(), await usdc.getAddress(), 3);
    const orbit: [string, string, string] = [pools[0], pools[1], pools[2]];

    // Bootstrap pools
    for (const poolAddr of orbit) {
      await bootstrapPool(treasury, poolAddr, asset, usdc, A, U, -500);
    }

    // Wire orbit
    await wireLegacyOrbit(treasury, router, orbit[0], orbit);

    // Fund and approve
    const amountIn = ethers.parseEther("1");
    await (await usdc.connect(deployer).mint(other.address, amountIn * 10n)).wait();
    const routerAddr = await router.getAddress();
    await approveMax(usdc, other, routerAddr);
    await approveMaxMany(usdc, other, orbit);

    // Pause the router
    await (await treasury.connect(deployer).pauseRouterViaTreasury(routerAddr)).wait();

    // Swap should revert
    await expect(
      runSwap({
        router,
        caller: other,
        startPool: orbit[0],
        amountIn,
      })
    ).to.be.revertedWithCustomError(router, "RouterPaused");
  });

  it("allows swap when unpaused", async () => {
    const env = await deployCore();
    const { deployer, treasury, router, factory, asset, usdc, other } = env;

    // Setup orbit with 3 pools
    const pools = await ensureNPools(factory, treasury, await asset.getAddress(), await usdc.getAddress(), 3);
    const orbit: [string, string, string] = [pools[0], pools[1], pools[2]];

    // Bootstrap pools
    for (const poolAddr of orbit) {
      await bootstrapPool(treasury, poolAddr, asset, usdc, A, U, -500);
    }

    // Wire orbit
    await wireLegacyOrbit(treasury, router, orbit[0], orbit);

    // Fund and approve
    const amountIn = ethers.parseEther("1");
    await (await usdc.connect(deployer).mint(other.address, amountIn * 20n)).wait();
    const routerAddr = await router.getAddress();
    await approveMax(usdc, other, routerAddr);
    await approveMaxMany(usdc, other, orbit);

    // Pause and unpause
    await (await treasury.connect(deployer).pauseRouterViaTreasury(routerAddr)).wait();
    await (await treasury.connect(deployer).unpauseRouterViaTreasury(routerAddr)).wait();

    // Swap should succeed
    await expect(
      runSwap({
        router,
        caller: other,
        startPool: orbit[0],
        amountIn,
      })
    ).to.not.be.reverted;
  });

  it("view functions still work when paused", async () => {
    const env = await deployCore();
    const { deployer, treasury, router, factory, asset, usdc } = env;

    // Setup orbit
    const pools = await ensureNPools(factory, treasury, await asset.getAddress(), await usdc.getAddress(), 3);
    const orbit: [string, string, string] = [pools[0], pools[1], pools[2]];

    for (const poolAddr of orbit) {
      await bootstrapPool(treasury, poolAddr, asset, usdc, A, U, -500);
    }

    await wireLegacyOrbit(treasury, router, orbit[0], orbit);

    // Pause
    await (await treasury.connect(deployer).pauseRouterViaTreasury(await router.getAddress())).wait();

    // View functions should still work
    const amountIn = ethers.parseEther("1");
    const quote = await router.getAmountsOut(amountIn, orbit, true);
    expect(quote).to.not.be.undefined;

    const orbitConfig = await router.getOrbit(orbit[0]);
    expect(orbitConfig.length).to.equal(3);

    const paused = await router.paused();
    expect(paused).to.equal(true);
  });

  it("pause is idempotent - can call pause multiple times", async () => {
    const env = await deployCore();
    const { deployer, treasury, router } = env;

    expect(await router.paused()).to.equal(false);

    // Call pause multiple times
    await (await treasury.connect(deployer).pauseRouterViaTreasury(await router.getAddress())).wait();
    await (await treasury.connect(deployer).pauseRouterViaTreasury(await router.getAddress())).wait();
    await (await treasury.connect(deployer).pauseRouterViaTreasury(await router.getAddress())).wait();

    expect(await router.paused()).to.equal(true);
  });

  it("unpause is idempotent - can call unpause multiple times", async () => {
    const env = await deployCore();
    const { deployer, treasury, router } = env;

    // Pause first
    await (await treasury.connect(deployer).pauseRouterViaTreasury(await router.getAddress())).wait();
    expect(await router.paused()).to.equal(true);

    // Call unpause multiple times
    await (await treasury.connect(deployer).unpauseRouterViaTreasury(await router.getAddress())).wait();
    await (await treasury.connect(deployer).unpauseRouterViaTreasury(await router.getAddress())).wait();
    await (await treasury.connect(deployer).unpauseRouterViaTreasury(await router.getAddress())).wait();

    expect(await router.paused()).to.equal(false);
  });
});



