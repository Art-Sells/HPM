// test/AccessGating.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import { deployCore } from "./helpers.ts";

describe("Access gating", () => {
  //
  // ───────────────────────────────── Permissions: LP-MCV & Approved ────────────────────────────────
  //
  describe("Permissions: LP-MCV & Approved Supplicators", () => {
    it("LP-MCV can supplicate", async () => {
      const { deployer, hook, router, pool } = await deployCore();

      await (await hook.mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("5"),
        amountUsdcDesired:  ethers.parseEther("5"),
        data: "0x",
      })).wait();

      await expect(router.supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0,
        to: deployer.address,
      })).not.to.be.reverted;
    });

    it("Approved Supplicator can supplicate without LP", async () => {
      const { other, access, router, pool } = await deployCore();
      await (await access.setApprovedSupplicator(other.address, true)).wait();

      await expect(router.connect(other).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0,
        to: other.address,
      })).not.to.be.reverted;
    });

    it("Unauthorized caller reverts (not LP-MCV and not Approved)", async () => {
      const { other, router, pool } = await deployCore();

      await expect(router.connect(other).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0,
        to: other.address,
      })).to.be.revertedWith("not permitted");
    });

    it("Approved toggling affects Router permission; LP-MCV remains allowed", async () => {
      const { deployer, other, access, hook, router, pool } = await deployCore();

      // Become LP-MCV
      await (await hook.mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("5"),
        amountUsdcDesired:  ethers.parseEther("5"),
        data: "0x",
      })).wait();

      // Approve 'other' → allowed
      await (await access.setApprovedSupplicator(other.address, true)).wait();
      await expect(
        router.connect(other).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0,
          to: other.address,
        })
      ).to.not.be.reverted;

      // Revoke → denied
      await (await access.setApprovedSupplicator(other.address, false)).wait();
      await expect(
        router.connect(other).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0,
          to: other.address,
        })
      ).to.be.revertedWith("not permitted");

      // Deployer still allowed via LP-MCV status
      await expect(
        router.connect(deployer).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0,
          to: deployer.address,
        })
      ).to.not.be.reverted;
    });

    it("LP-MCV loses permission after full burn", async () => {
      const { deployer, hook, router, pool } = await deployCore();

      // Become LP-MCV
      await hook.mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("5"),
        amountUsdcDesired:  ethers.parseEther("5"),
        data: "0x",
      });

      // Burn everything
      const liq = await pool.liquidityOf(deployer.address);
      await pool.connect(deployer).burn(deployer.address, liq);

      // Permission should be gone
      await expect(router.supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0,
        to: deployer.address
      })).to.be.revertedWith("not permitted");
    });
    it("LP-MCV retains permission after partial burn (until fully withdrawn)", async () => {
      const { deployer, hook, router, pool } = await deployCore();

      // Become LP-MCV
      await hook.mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("10"),
        amountUsdcDesired:  ethers.parseEther("10"),
        data: "0x",
      });

      // Get full liquidity position
      const totalLiq = await pool.liquidityOf(deployer.address);
      const halfLiq = totalLiq / 2n;

      // Burn only half
      await expect(pool.connect(deployer).burn(deployer.address, halfLiq))
        .to.emit(pool, "Burn");

      // Verify some liquidity remains
      const remaining = await pool.liquidityOf(deployer.address);
      expect(remaining).to.be.greaterThan(0n);

      // Should STILL be allowed to supplicate (LP-MCV permission intact)
      await expect(
        router.connect(deployer).supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0,
          to: deployer.address,
        })
      ).to.not.be.reverted;
    });

    it("LP-MCV is per-pool (no bleed across pools)", async () => {
      const { deployer, factory, hook, treasury, router } = await deployCore();

      // Become LP on pool0 only
      const pools = await factory.getPools();
      const pool0 = await ethers.getContractAt("LPPPool", pools[0]);
      await hook.mintWithRebate({
        pool: pools[0],
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("2"),
        amountUsdcDesired:  ethers.parseEther("2"),
        data: "0x",
      });

      // Create pool1 with hook wired (but deployer does NOT LP there)
      const Token = await ethers.getContractFactory("TestToken");
      const a = await Token.deploy("A","A"); await a.waitForDeployment();
      const u = await Token.deploy("U","U"); await u.waitForDeployment();
      await treasury.createPoolViaTreasury(await factory.getAddress(), await a.getAddress(), await u.getAddress());
      const pool1Addr = (await factory.getPools())[1];
      await treasury.setPoolHookViaTreasury(await factory.getAddress(), pool1Addr, await hook.getAddress());

      // Not LP on pool1 → not permitted
      await expect(router.supplicate({
        pool: pool1Addr,
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0,
        to: deployer.address
      })).to.be.revertedWith("not permitted");
    });

    it("LP tokens are non-transferable; any transfer attempt is impossible", async () => {
      const { deployer, other, hook, pool } = await deployCore();

      // Become LP-MCV
      await hook.mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("5"),
        amountUsdcDesired: ethers.parseEther("5"),
        data: "0x",
      });

      // Ensure LP has some liquidity
      const liq = await pool.liquidityOf(deployer.address);
      expect(liq).to.be.greaterThan(0n);

      expect((pool as any).transfer).to.equal(undefined);

      try {
        await (pool as any).connect(deployer).transfer(other.address, liq);
        throw new Error("Unexpectedly succeeded in calling transfer");
      } catch (err: any) {
        // TypeScript/Hardhat throws before EVM revert because function selector doesn't exist
        expect(err.message).to.match(/is not a function|not a function|transfer is not defined/);
      }

      const liqAfter = await pool.liquidityOf(deployer.address);
      expect(liqAfter).to.equal(liq);
    });
    
  });

  //
  // ───────────────────────────────── Treasury-only Authorizations ─────────────────────────────────
  //
  describe("Treasury-only authorizations", () => {
    it("Treasury-only: createPool + setPoolHook", async () => {
      const { deployer, factory, hook, treasury } = await deployCore();

      const Token = await ethers.getContractFactory("TestToken");
      const asset2 = await Token.deploy("Asset2", "A2");
      const usdc2  = await Token.deploy("USD Coin 2", "USDC2");
      await asset2.waitForDeployment();
      await usdc2.waitForDeployment();

      const [, stranger] = await ethers.getSigners();

      await expect(
        factory.connect(stranger).createPool(await asset2.getAddress(), await usdc2.getAddress())
      ).to.be.revertedWith("only treasury");

      await expect(
        treasury.connect(stranger).createPoolViaTreasury(
          await factory.getAddress(),
          await asset2.getAddress(),
          await usdc2.getAddress()
        )
      ).to.be.revertedWith("not owner");

      await expect(
        treasury.connect(deployer).createPoolViaTreasury(
          await factory.getAddress(),
          await asset2.getAddress(),
          await usdc2.getAddress()
        )
      ).to.not.be.reverted;

      const poolAddr = (await factory.getPools())[1];

      await expect(
        factory.connect(stranger).setPoolHook(poolAddr, await hook.getAddress())
      ).to.be.revertedWith("only treasury");

      await expect(
        treasury.connect(stranger).setPoolHookViaTreasury(
          await factory.getAddress(),
          poolAddr,
          await hook.getAddress()
        )
      ).to.be.revertedWith("not owner");

      await expect(
        treasury.connect(deployer).setPoolHookViaTreasury(
          await factory.getAddress(),
          poolAddr,
          await hook.getAddress()
        )
      ).to.not.be.reverted;
    });

    it("Treasury-only: bootstrap via Hook; non-treasury reverts", async () => {
      const { deployer, other, hook, pool, treasury } = await deployCore();

      // non-treasury cannot bootstrap (direct call to hook)
      await expect(
        hook.connect(other).bootstrap(
          await pool.getAddress(),
          ethers.parseEther("1"),
          ethers.parseEther("1"),
        )
      ).to.be.revertedWith("only treasury");

      // treasury call again should hit 'already init'
      await expect(
        treasury.connect(deployer).bootstrapViaTreasury(
          await hook.getAddress(),
          await pool.getAddress(),
          ethers.parseEther("1"),
          ethers.parseEther("1"),
        )
      ).to.be.revertedWith("already init");
    });

    it("factory.setTreasury: only current treasury; authority transfers correctly", async () => {
      const { deployer, factory, treasury } = await deployCore();
      const [, newOwner, stranger] = await ethers.getSigners();

      // 1) Only current treasury may call setTreasury
      await expect(
        factory.connect(stranger).setTreasury(newOwner.address)
      ).to.be.revertedWith("only treasury");

      // 2) Rotate via Treasury forwarder; verify event + state
      const oldTreasury = await factory.treasury();
      await expect(
        treasury.connect(deployer).rotateFactoryTreasury(
          await factory.getAddress(),
          newOwner.address
        )
      )
        .to.emit(factory, "TreasuryUpdated")
        .withArgs(oldTreasury, newOwner.address);

      expect(await factory.treasury()).to.equal(newOwner.address);

      // 3) Old Treasury can no longer mutate factory
      const Token = await ethers.getContractFactory("TestToken");
      const a = await Token.deploy("A","A"); await a.waitForDeployment();
      const u = await Token.deploy("U","U"); await u.waitForDeployment();

      await expect(
        treasury.connect(deployer).createPoolViaTreasury(
          await factory.getAddress(),
          await a.getAddress(),
          await u.getAddress()
        )
      ).to.be.revertedWith("only treasury");

      // 4) New treasury address (EOA) can call Factory directly now
      await expect(
        factory.connect(newOwner).createPool(await a.getAddress(), await u.getAddress())
      ).to.not.be.reverted;

      // 5) Optional hardening: zero-address rotation should revert (if enforced)
      await expect(
        factory.connect(newOwner).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWith("zero treasury");
    });

    it("LPPTreasury.rotateFactoryTreasury: only owner", async () => {
      const { factory, treasury } = await deployCore();
      const [, stranger] = await ethers.getSigners();
      await expect(
        treasury.connect(stranger).rotateFactoryTreasury(await factory.getAddress(), stranger.address)
      ).to.be.revertedWith("not owner");
    });
    it("After rotating treasury to an EOA, that EOA can setPoolHook directly", async () => {
  const { deployer, factory, treasury, hook } = await deployCore();
  const [, newEOA] = await ethers.getSigners();

  // Rotate treasury to EOA
  await treasury.connect(deployer).rotateFactoryTreasury(await factory.getAddress(), newEOA.address);
  expect(await factory.treasury()).to.equal(newEOA.address);

  // Deploy new pool
  const Token = await ethers.getContractFactory("TestToken");
  const a = await Token.deploy("A","A"); await a.waitForDeployment();
  const u = await Token.deploy("U","U"); await u.waitForDeployment();
  await factory.connect(newEOA).createPool(await a.getAddress(), await u.getAddress());
  const poolAddr = (await factory.getPools())[1];

  // Verify EOA can setPoolHook directly
  await expect(factory.connect(newEOA).setPoolHook(poolAddr, await hook.getAddress())).to.not.be.reverted;
});

it("After rotating treasury to a new Treasury contract, only the new one can call factory methods", async () => {
  const { deployer, factory, treasury } = await deployCore();
  const Treasury = await ethers.getContractFactory("LPPTreasury");

  // ✅ Deploy LPPTreasury2 properly with required args
  const treasury2 = await Treasury.deploy(await factory.getAddress(), deployer.address);
  await treasury2.waitForDeployment();

  // Rotate to treasury2
  await treasury.connect(deployer).rotateFactoryTreasury(await factory.getAddress(), await treasury2.getAddress());
  expect(await factory.treasury()).to.equal(await treasury2.getAddress());

  // Old treasury should now fail
  const Token = await ethers.getContractFactory("TestToken");
  const a = await Token.deploy("A", "A"); await a.waitForDeployment();
  const u = await Token.deploy("U", "U"); await u.waitForDeployment();

  await expect(
    treasury.createPoolViaTreasury(await factory.getAddress(), await a.getAddress(), await u.getAddress())
  ).to.be.revertedWith("only treasury");

  // ✅ New treasury can call successfully
  await expect(
    treasury2.createPoolViaTreasury(await factory.getAddress(), await a.getAddress(), await u.getAddress())
  ).to.not.be.reverted;
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

      // already wired in deployCore — second wire must fail
      await expect(
        treasury.connect(deployer).setPoolHookViaTreasury(
          await factory.getAddress(),
          await pool.getAddress(),
          await hook.getAddress()
        )
      ).to.be.revertedWith("hook set");

      // zero hook
      const zero = ethers.ZeroAddress;
      await expect(
        treasury.connect(deployer).setPoolHookViaTreasury(
          await factory.getAddress(),
          await pool.getAddress(),
          zero
        )
      ).to.be.revertedWith("zero hook");

      // unknown pool
      const fakePool = "0x000000000000000000000000000000000000dEaD";
      await expect(
        treasury.connect(deployer).setPoolHookViaTreasury(
          await factory.getAddress(),
          fakePool,
          await hook.getAddress()
        )
      ).to.be.revertedWith("unknown pool");
    });

    it("pool.bootstrapInitialize: only hook allowed", async () => {
      const { other, pool } = await deployCore();
      await expect(
        (pool as any).connect(other).bootstrapInitialize(
          ethers.parseEther("1"),
          ethers.parseEther("1")
        )
      ).to.be.revertedWith("only hook");
    });

    it("hook.bootstrap before hook wiring on a fresh pool reverts (via Treasury path)", async () => {
      const { deployer, treasury, factory, hook } = await deployCore();

      // Fresh pool with NO hook wired
      const Token = await ethers.getContractFactory("TestToken");
      const asset2 = await Token.deploy("Asset2","A2"); await asset2.waitForDeployment();
      const usdc2  = await Token.deploy("USDC2","U2");  await usdc2.waitForDeployment();

      await treasury.connect(deployer).createPoolViaTreasury(
        await factory.getAddress(),
        await asset2.getAddress(),
        await usdc2.getAddress()
      );
      const pool2 = (await factory.getPools())[1];

      // Call bootstrap THROUGH TREASURY so hook.onlyTreasury passes,
      // then pool.bootstrapInitialize reverts with "only hook" (hook not wired).
      await expect(
        treasury.connect(deployer).bootstrapViaTreasury(
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
        treasury.connect(deployer).bootstrapViaTreasury(
          await hook.getAddress(),
          await pool.getAddress(),
          ethers.parseEther("1"),
          ethers.parseEther("1")
        )
      ).to.be.revertedWith("already init");
    });

    it("mintWithRebate reverts if pool has no hook wired", async () => {
      const { deployer, treasury, factory, hook, asset, usdc } = await deployCore();

      const Token = await ethers.getContractFactory("TestToken");
      const a = await Token.deploy("A","A"); await a.waitForDeployment();
      const u = await Token.deploy("U","U"); await u.waitForDeployment();
      await treasury.createPoolViaTreasury(await factory.getAddress(), await a.getAddress(), await u.getAddress());
      const pool2 = (await factory.getPools())[1];

      await asset.mint(deployer.address, ethers.parseEther("10"));
      await usdc.mint(deployer.address,  ethers.parseEther("10"));

      await expect(hook.mintWithRebate({
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
        treasury.connect(deployer).bootstrapViaTreasury(
          await hook.getAddress(),
          await pool.getAddress(),
          0,
          0
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

      // Transfer ownership
      await access.connect(deployer).transferOwnership(newOwner.address);
      expect(await access.owner()).to.equal(newOwner.address);

      // Old owner can no longer approve
      await expect(access.connect(deployer).setApprovedSupplicator(other.address, true))
        .to.be.revertedWith("not owner");

      // New owner can approve
      await expect(access.connect(newOwner).setApprovedSupplicator(other.address, true))
        .to.not.be.reverted;
    });
    it("Router rejects unknown pool", async () => {
      const { deployer, router } = await deployCore();
      const fake = "0x000000000000000000000000000000000000dEaD";

      await expect(router.supplicate({
        pool: fake,
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0,
        to: deployer.address
      })).to.be.reverted; // ideally a specific "unknown pool" reason if emitted
    });

    it("supplicate: slippage reverts when minAmountOut too high", async () => {
      const { deployer, hook, router, pool } = await deployCore();

      await (await hook.mintWithRebate({
        pool: await pool.getAddress(),
        to: deployer.address,
        amountAssetDesired: ethers.parseEther("5"),
        amountUsdcDesired:  ethers.parseEther("5"),
        data: "0x",
      })).wait();

      // Ask for impossible minAmountOut
      await expect(
        router.supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: ethers.parseEther("1000"),
          to: deployer.address,
        })
      ).to.be.revertedWith("slippage");
    });

    it("supplicate before bootstrap: empty reserves (no hook, no mint)", async () => {
      const { deployer, treasury, factory, router, access } = await deployCore();

      // Make a brand-new pool with zero liquidity
      const Token = await ethers.getContractFactory("TestToken");
      const a = await Token.deploy("A","A"); await a.waitForDeployment();
      const u = await Token.deploy("U","U"); await u.waitForDeployment();

      await treasury.createPoolViaTreasury(
        await factory.getAddress(),
        await a.getAddress(),
        await u.getAddress()
      );
      const poolAddr = (await factory.getPools())[1];
      const pool = await ethers.getContractAt("LPPPool", poolAddr);

      // Authorize via AccessManager (no LP mint)
      await access.setApprovedSupplicator(deployer.address, true);

      await expect(
        router.supplicate({
          pool: await pool.getAddress(),
          assetToUsdc: true,
          amountIn: ethers.parseEther("1"),
          minAmountOut: 0,
          to: deployer.address,
        })
      ).to.be.revertedWith("empty reserves");
    });

    it("factory.createPool: rejects zero token addresses", async () => {
      const { deployer, factory, treasury } = await deployCore();
      const Token = await ethers.getContractFactory("TestToken");
      const a = await Token.deploy("A","A"); await a.waitForDeployment();

      await expect(
        treasury.connect(deployer).createPoolViaTreasury(
          await factory.getAddress(),
          ethers.ZeroAddress,
          await a.getAddress()
        )
      ).to.be.revertedWith("zero token");

      await expect(
        treasury.connect(deployer).createPoolViaTreasury(
          await factory.getAddress(),
          await a.getAddress(),
          ethers.ZeroAddress
        )
      ).to.be.revertedWith("zero token");
    });

    it("Approval checked on caller, not recipient", async () => {
      const { other, deployer, access, router, pool } = await deployCore();
      await access.setApprovedSupplicator(deployer.address, true); // approve recipient, not caller

      await expect(router.connect(other).supplicate({
        pool: await pool.getAddress(),
        assetToUsdc: true,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 0,
        to: deployer.address
      })).to.be.revertedWith("not permitted");
    });

    it("AccessManager: cannot approve zero address", async () => {
      const { access } = await deployCore();
      await expect(access.setApprovedSupplicator(ethers.ZeroAddress, true)).to.be.reverted;
    });
  });
});