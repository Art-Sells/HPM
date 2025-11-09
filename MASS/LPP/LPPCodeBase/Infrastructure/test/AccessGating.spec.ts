import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import { deployCore } from "./helpers.ts";

/* ---------- local helpers: safe dummy pairs + allow-list + pool creation ---------- */
function randAddr() {
  return ethers.Wallet.createRandom().address;
}
function pair() {
  let a = randAddr();
  let u = randAddr();
  if (u.toLowerCase() === a.toLowerCase()) u = randAddr();
  return { a, u };
}

async function allowPairViaTreasury(treasury: any, factory: any, a: string, u: string) {
  await (await treasury.allowTokenViaTreasury(await factory.getAddress(), a, true)).wait();
  await (await treasury.allowTokenViaTreasury(await factory.getAddress(), u, true)).wait();
}

async function createPoolOnly(treasury: any, factory: any) {
  const { a, u } = pair();
  await allowPairViaTreasury(treasury, factory, a, u);
  await (await treasury.createPoolViaTreasury(await factory.getAddress(), a, u)).wait();
  const pools = await factory.getPools();
  return pools[pools.length - 1] as string;
}

async function createPoolAndWireHook(treasury: any, factory: any, hook: any) {
  const poolAddr = await createPoolOnly(treasury, factory);
  await (await treasury.setPoolHookViaTreasury(
    await factory.getAddress(),
    poolAddr,
    await hook.getAddress()
  )).wait();
  return poolAddr;
}

/* convenience for signature-indexed bootstrap */
const BOOTstrap4 = "bootstrapViaTreasury(address,address,uint256,uint256)";

/* ---------- funding + approval helpers for router.supplicate payer ---------- */
async function fundAndApprove(
  token: any,            // TestERC20
  payerSigner: any,      // signer of the payer
  router: any,           // LPPRouter
  minAmount: bigint
) {
  const payerAddr = await payerSigner.getAddress();
  const bal = await token.balanceOf(payerAddr);
  if (bal < minAmount) {
    throw new Error("fundAndApprove: call mintFundAndApprove (no balance)");
  }
  await (await token.connect(payerSigner).approve(await router.getAddress(), ethers.MaxUint256)).wait();
}

async function mintFundAndApprove(
  token: any,
  tokenOwner: any,       // deployer (minter)
  payerSigner: any,
  router: any,
  amount: bigint
) {
  const payerAddr = await payerSigner.getAddress();
  await (await token.connect(tokenOwner).mint(payerAddr, amount)).wait();
  await (await token.connect(payerSigner).approve(await router.getAddress(), ethers.MaxUint256)).wait();
}

describe("Access gating", () => {
  //
  // ───────────────────────────────── Permissions: LP-MCV & Approved ────────────────────────────────
  //
  describe("Permissions: LP-MCV & Approved Supplicators", () => {
    it("LP-MCV can supplicate", async () => {
      const { deployer, hook, router, pool, asset } = await deployCore();

      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("5"),
        amountUsdcDesired:  ethers.parseEther("5"),
        data: "0x",
      })).wait();

      // give deployer input tokens and approve router
      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("2"));

      await expect((router as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      })).not.to.be.reverted;
    });

    it("Approved Supplicator can supplicate without LP", async () => {
      const { deployer, other, access, router, pool, asset } = await deployCore();
      await (await access.setApprovedSupplicator(other.address, true)).wait();

      // fund & approve for `other` (payer)
      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("2"));

      await expect((router.connect(other) as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: other.address,
        payer: other.address,
      })).not.to.be.reverted;
    });

    it("Unauthorized caller reverts (not LP-MCV and not Approved)", async () => {
      const { other, router, pool } = await deployCore();

      await expect((router.connect(other) as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: other.address,
        payer: other.address,
      })).to.be.revertedWith("not permitted");
    });

    it("Approved toggling affects Router permission; LP-MCV remains allowed", async () => {
      const { deployer, other, access, hook, router, pool, asset } = await deployCore();

      // Become LP-MCV
      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("5"),
        amountUsdcDesired:  ethers.parseEther("5"),
        data: "0x",
      })).wait();

      // Approve 'other' → allowed
      await (await access.setApprovedSupplicator(other.address, true)).wait();
      await mintFundAndApprove(asset, deployer, other, router, ethers.parseEther("2"));
      await expect(
        (router.connect(other) as any).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
          to: other.address,
          payer: other.address,
        })
      ).to.not.be.reverted;

      // Revoke → denied
      await (await access.setApprovedSupplicator(other.address, false)).wait();
      await expect(
        (router.connect(other) as any).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
          to: other.address,
          payer: other.address,
        })
      ).to.be.revertedWith("not permitted");

      // Deployer still allowed via LP-MCV status
      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("2"));
      await expect(
        (router.connect(deployer) as any).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
          to: deployer.address,
          payer: deployer.address,
        })
      ).to.not.be.reverted;
    });

    it("LP-MCV loses permission after full burn", async () => {
      const { deployer, hook, router, pool, asset } = await deployCore();

      // Become LP-MCV
      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("5"),
        amountUsdcDesired:  ethers.parseEther("5"),
        data: "0x",
      })).wait();

      // Burn everything
      const liq = await (pool as any).liquidityOf(deployer.address);
      await (pool as any).connect(deployer).burn(deployer.address, liq);

      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("2"));

      // Permission should be gone
      await expect((router as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address
      })).to.be.revertedWith("not permitted");
    });

    it("LP-MCV retains permission after partial burn (until fully withdrawn)", async () => {
      const { deployer, hook, router, pool, asset } = await deployCore();

      // Become LP-MCV
      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("10"),
        amountUsdcDesired:  ethers.parseEther("10"),
        data: "0x",
      })).wait();

      // Get full liquidity position
      const totalLiq = await (pool as any).liquidityOf(deployer.address);
      const halfLiq = totalLiq / 2n;

      // Burn only half
      await expect((pool as any).connect(deployer).burn(deployer.address, halfLiq))
        .to.emit(pool, "Burn");

      // Verify some liquidity remains
      const remaining = await (pool as any).liquidityOf(deployer.address);
      expect(remaining).to.be.greaterThan(0n);

      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("2"));

      // Should STILL be allowed to supplicate (LP-MCV permission intact)
      await expect(
        (router.connect(deployer) as any).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
          to: deployer.address,
          payer: deployer.address,
        })
      ).to.not.be.reverted;
    });

    it("LP-MCV is per-pool (no bleed across pools)", async () => {
      const { deployer, factory, hook, treasury, router, asset } = await deployCore();

      // Become LP on pool0 only
      const pools = await factory.getPools();
      await (await (hook as any).mintWithRebate({
        pool: pools[0],
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("2"),
        amountUsdcDesired:  ethers.parseEther("2"),
        data: "0x",
      })).wait();

      // Create pool1 with hook wired (but deployer does NOT LP there)
      const pool1Addr = await createPoolAndWireHook(treasury, factory, hook);

      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("2"));

      // Not LP on pool1 → not permitted
      await expect((router as any).supplicate({
        pool: pool1Addr,
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address
      })).to.be.revertedWith("not permitted");
    });

    it("LP tokens are non-transferable; any transfer attempt is impossible", async () => {
      const { deployer, other, hook, pool } = await deployCore();

      // Become LP-MCV
      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("5"),
        amountUsdcDesired: ethers.parseEther("5"),
        data: "0x",
      })).wait();

      // Ensure LP has some liquidity
      const liq = await (pool as any).liquidityOf(deployer.address);
      expect(liq).to.be.greaterThan(0n);

      expect((pool as any).transfer).to.equal(undefined);

      try {
        await (pool as any).connect(deployer).transfer(other.address, liq);
        throw new Error("Unexpectedly succeeded in calling transfer");
      } catch (err: any) {
        expect(err.message).to.match(/is not a function|not a function|transfer is not defined/);
      }

      const liqAfter = await (pool as any).liquidityOf(deployer.address);
      expect(liqAfter).to.equal(liq);
    });

    it("Approved Supplicator does not gain LP ownership rights (cannot burn someone else's liquidity)", async () => {
      const { deployer, other, access, hook, pool } = await deployCore();

      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("3"),
        amountUsdcDesired:  ethers.parseEther("3"),
        data: "0x",
      })).wait();

      await (await access.setApprovedSupplicator(other.address, true)).wait();

      const liq = await (pool as any).liquidityOf(deployer.address);
      await expect(
        (pool as any).connect(other).burn(deployer.address, liq)
      ).to.be.reverted; // ownership enforced inside pool.burn
    });
  });

  //
  // ───────────────────────────────── Treasury-only Authorizations ─────────────────────────────────
  //
  describe("Treasury-only authorizations", () => {
    it("Treasury-only: createPool + setPoolHook", async () => {
      const { deployer, factory, hook, treasury } = await deployCore();
      const [, stranger] = await ethers.getSigners();

      const { a, u } = pair();

      await expect(
        factory.connect(stranger).createPool(a, u)
      ).to.be.revertedWith("only treasury");

      await expect(
        treasury.connect(stranger).createPoolViaTreasury(
          await factory.getAddress(), a, u
        )
      ).to.be.revertedWith("not owner");

      // allow-list before the real call
      await allowPairViaTreasury(treasury, factory, a, u);

      await expect(
        treasury.connect(deployer).createPoolViaTreasury(
          await factory.getAddress(), a, u
        )
      ).to.not.be.reverted;

      const poolAddr = (await factory.getPools())[1];

      await expect(
        factory.connect(stranger).setPoolHook(poolAddr, await hook.getAddress())
      ).to.be.revertedWith("only treasury");

      await expect(
        treasury.connect(stranger).setPoolHookViaTreasury(
          await factory.getAddress(), poolAddr, await hook.getAddress()
        )
      ).to.be.revertedWith("not owner");

      await expect(
        treasury.connect(deployer).setPoolHookViaTreasury(
          await factory.getAddress(), poolAddr, await hook.getAddress()
        )
      ).to.not.be.reverted;
    });

    it("Treasury-only: bootstrap via Hook; non-treasury reverts", async () => {
      const { deployer, other, hook, pool, treasury } = await deployCore();

      // non-treasury cannot bootstrap (direct call to hook)
      await expect(
        (hook as any).connect(other).bootstrap(
          await pool.getAddress(),
          ethers.parseEther("1"),
          ethers.parseEther("1"),
          0 // offsetBps
        )
      ).to.be.revertedWith("only treasury");

      // treasury call again should hit 'already init'
      await expect(
        (treasury.connect(deployer) as any)[BOOTstrap4](
          await hook.getAddress(),
          await pool.getAddress(),
          ethers.parseEther("1"),
          ethers.parseEther("1")
        )
      ).to.be.revertedWith("already init");
    });

    it("factory.setTreasury: only current treasury; authority transfers correctly", async () => {
      const { deployer, factory, treasury } = await deployCore();
      const [, newOwner, stranger] = await ethers.getSigners();

      await expect(
        factory.connect(stranger).setTreasury(newOwner.address)
      ).to.be.revertedWith("only treasury");

      const oldTreasury = await factory.treasury();
      await expect(
        (treasury.connect(deployer) as any).rotateFactoryTreasury(
          await factory.getAddress(), newOwner.address
        )
      )
        .to.emit(factory, "TreasuryUpdated")
        .withArgs(oldTreasury, newOwner.address);

      expect(await factory.treasury()).to.equal(newOwner.address);

      // Old treasury can no longer mutate factory
      const { a, u } = pair();

      // Expect allow-list attempts by old treasury to revert
      await expect(
        (treasury.connect(deployer) as any).allowTokenViaTreasury(
          await factory.getAddress(), a, true
        )
      ).to.be.revertedWith("only treasury");
      await expect(
        (treasury.connect(deployer) as any).allowTokenViaTreasury(
          await factory.getAddress(), u, true
        )
      ).to.be.revertedWith("only treasury");

      await expect(
        (treasury.connect(deployer) as any).createPoolViaTreasury(
          await factory.getAddress(), a, u
        )
      ).to.be.revertedWith("only treasury");

      // New EOA can call factory directly
      await expect(
        factory.connect(newOwner).createPool(a, u)
      ).to.not.be.reverted;

      await expect(
        factory.connect(newOwner).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWith("zero treasury");
    });

    it("LPPTreasury.rotateFactoryTreasury: only owner", async () => {
      const { factory, treasury } = await deployCore();
      const [, stranger] = await ethers.getSigners();
      await expect(
        (treasury.connect(stranger) as any).rotateFactoryTreasury(
          await factory.getAddress(), stranger.address
        )
      ).to.be.revertedWith("not owner");
    });

    it("After rotating treasury to an EOA, that EOA can setPoolHook directly", async () => {
      const { deployer, factory, treasury, hook } = await deployCore();
      const [, newEOA] = await ethers.getSigners();

      await (treasury.connect(deployer) as any).rotateFactoryTreasury(
        await factory.getAddress(), newEOA.address
      );
      expect(await factory.treasury()).to.equal(newEOA.address);

      const { a, u } = pair();
      // old treasury attempts do nothing (no revert needed here, just proceed)
      await (factory.connect(newEOA) as any).createPool(a, u);
      const poolAddr = (await factory.getPools())[1];

      await expect(
        factory.connect(newEOA).setPoolHook(poolAddr, await hook.getAddress())
      ).to.not.be.reverted;
    });

    it("Treasury address is not inherently permitted to trade (impersonated treasury caller reverts)", async () => {
      const { deployer, treasury, router, pool, hook, access } = await deployCore();

      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("2"),
        amountUsdcDesired:  ethers.parseEther("2"),
        data: "0x",
      })).wait();

      const treasuryAddr = await treasury.getAddress();
      await (await access.setApprovedSupplicator(treasuryAddr, false)).wait();

      await ethers.provider.send("hardhat_impersonateAccount", [treasuryAddr]);
      await ethers.provider.send("hardhat_setBalance", [
        treasuryAddr,
        "0x56BC75E2D63100000", // 100 ETH
      ]);
      const treasurySigner = await ethers.getSigner(treasuryAddr);

      const liq = await (pool as any).liquidityOf(treasuryAddr);
      if (liq > 0n) {
        await (pool as any).connect(treasurySigner).burn(treasuryAddr, liq);
      }

      await expect(
        (router.connect(treasurySigner) as any).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
          to: treasuryAddr,
          payer: treasuryAddr,
        })
      ).to.be.revertedWith("not permitted");
    });
  });

  //
  // ───────────────────────────────── Hook wiring & Bootstrap guards ────────────────────────────────
  //
  describe("Hook wiring & Bootstrap guards", () => {
    it("Non-hook cannot call pool.mintFromHook (only hook allowed)", async () => {
      const { other, pool } = await deployCore();

      await expect(
        (pool as any).connect(other).mintFromHook(
          other.address,
          ethers.parseEther("1"),
          ethers.parseEther("1"),
        )
      ).to.be.revertedWith("only hook");
    });

    it("setPoolHook: only once; zero hook; unknown pool", async () => {
      const { deployer, factory, hook, pool, treasury } = await deployCore();

      await expect(
        (treasury.connect(deployer) as any).setPoolHookViaTreasury(
          await factory.getAddress(),
          await pool.getAddress(),
          await hook.getAddress()
        )
      ).to.be.revertedWith("hook set");

      const zero = ethers.ZeroAddress;
      await expect(
        (treasury.connect(deployer) as any).setPoolHookViaTreasury(
          await factory.getAddress(),
          await pool.getAddress(),
          zero
        )
      ).to.be.revertedWith("zero hook");

      const fakePool = "0x000000000000000000000000000000000000dEaD";
      await expect(
        (treasury.connect(deployer) as any).setPoolHookViaTreasury(
          await factory.getAddress(),
          fakePool,
          await hook.getAddress()
        )
      ).to.be.revertedWith("unknown pool");
    });

    it("hook.bootstrap before hook wiring on a fresh pool reverts (via Treasury path)", async () => {
      const { deployer, treasury, factory, hook } = await deployCore();

      // Fresh pool with NO hook wired
      const pool2 = await createPoolOnly(treasury, factory);

      await expect(
        (treasury.connect(deployer) as any)[BOOTstrap4](
          await hook.getAddress(),
          pool2,
          ethers.parseEther("1"),
          ethers.parseEther("1")
        )
      ).to.be.revertedWith("only hook");
    });

    it("hook.bootstrap: only once per pool", async () => {
      const { deployer, hook, pool, treasury } = await deployCore();

      // First bootstrap already performed in deployCore; second attempt must revert
      await expect(
        (treasury.connect(deployer) as any)[BOOTstrap4](
          await hook.getAddress(),
          await pool.getAddress(),
          ethers.parseEther("1"),
          ethers.parseEther("1")
        )
      ).to.be.revertedWith("already init");
    });

    it("mintWithRebate reverts if pool has no hook wired", async () => {
      const { deployer, treasury, factory, hook } = await deployCore();

      const pool2 = await createPoolOnly(treasury, factory);

      await expect((hook as any).mintWithRebate({
        pool: pool2,
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("1"),
        amountUsdcDesired:  ethers.parseEther("1"),
        data: "0x",
      })).to.be.revertedWith("pool not initialized");
    });

    it("bootstrapViaTreasury with zero amounts reverts", async () => {
      const { deployer, treasury, hook, pool } = await deployCore();

      await expect(
        (treasury.connect(deployer) as any)[BOOTstrap4](
          await hook.getAddress(),
          await pool.getAddress(),
          0n,
          0n
        )
      ).to.be.revertedWith("zero");
      await expect(
        (treasury.connect(deployer) as any)[BOOTstrap4](
          await hook.getAddress(),
          await pool.getAddress(),
          0n,
          ethers.parseEther("1")
        )
      ).to.be.revertedWith("zero");
      await expect(
        (treasury.connect(deployer) as any)[BOOTstrap4](
          await hook.getAddress(),
          await pool.getAddress(),
          ethers.parseEther("1"),
          0n
        )
      ).to.be.revertedWith("zero");
    });
  });

  //
  // ───────────────────────────────── Router validation & Slippage/Reserves ────────────────────────
  //
  describe("Router validation & Slippage/Reserves", () => {
    it("Ownership transfer updates approver; old owner loses permission", async () => {
      const { deployer, other, access } = await deployCore();
      const [, newOwner] = await ethers.getSigners();

      await (access.connect(deployer) as any).transferOwnership(newOwner.address);
      expect(await access.owner()).to.equal(newOwner.address);

      await expect(
        (access.connect(deployer) as any).setApprovedSupplicator(other.address, true)
      ).to.be.revertedWith("not owner");

      await expect(
        (access.connect(newOwner) as any).setApprovedSupplicator(other.address, true)
      ).to.not.be.reverted;
    });

    it("Router rejects unknown pool", async () => {
      const { deployer, router } = await deployCore();
      const fake = "0x000000000000000000000000000000000000dEaD";

      await expect((router as any).supplicate({
        pool: fake,
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address
      })).to.be.reverted;
    });

    it("supplicate: slippage reverts when minAmountOut too high", async () => {
      const { deployer, hook, router, pool, asset } = await deployCore();

      await (await (hook as any).mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("5"),
        amountUsdcDesired:  ethers.parseEther("5"),
        data: "0x",
      })).wait();

      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("2"));

      await expect(
        (router as any).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: ethers.parseEther("1000"),
          to: deployer.address,
          payer: deployer.address,
        })
      ).to.be.revertedWith("slippage");
    });

    it("supplicate before bootstrap: empty reserves (no hook, no mint)", async () => {
      const { deployer, treasury, factory, router, access, asset } = await deployCore();

      const poolAddr = await createPoolOnly(treasury, factory);
      const pool = await ethers.getContractAt("LPPPool", poolAddr);

      await (await access.setApprovedSupplicator(deployer.address, true)).wait();

      await mintFundAndApprove(asset, deployer, deployer, router, ethers.parseEther("2"));

      await expect(
        (router as any).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0n,
          to: deployer.address,
          payer: deployer.address,
        })
      ).to.be.revertedWith("empty reserves");
    });

    it("factory.createPool: rejects zero token addresses", async () => {
      const { deployer, factory, treasury } = await deployCore();
      const { a } = pair();

      await expect(
        (treasury.connect(deployer) as any).createPoolViaTreasury(
          await factory.getAddress(), ethers.ZeroAddress, a
        )
      ).to.be.revertedWith("zero token");

      await expect(
        (treasury.connect(deployer) as any).createPoolViaTreasury(
          await factory.getAddress(), a, ethers.ZeroAddress
        )
      ).to.be.revertedWith("zero token");
    });

    it("Approval checked on caller, not recipient", async () => {
      const { other, deployer, access, router, pool } = await deployCore();
      await (await access.setApprovedSupplicator(deployer.address, true)).wait();

      await expect((router.connect(other) as any).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0n,
        to: deployer.address,
        payer: deployer.address,
      })).to.be.revertedWith("not permitted");
    });

    it("AccessManager: cannot approve zero address", async () => {
      const { access } = await deployCore();
      await expect((access as any).setApprovedSupplicator(ethers.ZeroAddress, true)).to.be.reverted;
    });
  });
});