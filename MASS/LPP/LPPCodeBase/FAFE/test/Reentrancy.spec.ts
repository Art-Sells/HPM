// test/Reentrancy.spec.ts
import hre from "hardhat";
const { ethers, network } = hre;
import { expect } from "./shared/expect.ts";

/*─────────────────────────────────────────────────────────────────────────────*
 * Reentrancy helper contracts (Solidity inlined & compiled via Hardhat)
 *─────────────────────────────────────────────────────────────────────────────*/

// Malicious ERC20 that reenters during transferFrom(...) into a designated target contract
const REENTER_ON_TRANSFERFROM_SRC = `
  // SPDX-License-Identifier: MIT
  pragma solidity ^0.8.24;

  interface ITarget {
    function claim() external; // optional ABI for simple smoke tests
  }

  contract ReenterOnTransferFrom {
    string public name = "ReenterOnTransferFrom";
    string public symbol = "ROT";
    uint8  public decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // reentrancy config
    address public reenterTarget;
    bytes   public reenterCalldata;
    bool    public reenterEnabled;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
      balanceOf[msg.sender] = 0;
    }

    function setReenter(address target, bytes calldata data, bool enabled) external {
      reenterTarget = target;
      reenterCalldata = data;
      reenterEnabled = enabled;
    }

    function mint(address to, uint256 amt) external {
      balanceOf[to] += amt;
      emit Transfer(address(0), to, amt);
    }

    function approve(address spender, uint256 amt) external returns (bool) {
      allowance[msg.sender][spender] = amt;
      emit Approval(msg.sender, spender, amt);
      return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
      require(balanceOf[msg.sender] >= amt, "bal");
      balanceOf[msg.sender] -= amt;
      balanceOf[to] += amt;
      emit Transfer(msg.sender, to, amt);

      // NO reentry here; this contract reenters only on transferFrom
      return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
      uint256 allow = allowance[from][msg.sender];
      require(allow >= amt, "allow");
      require(balanceOf[from] >= amt, "bal");
      allowance[from][msg.sender] = allow - amt;

      // 1) perform reentry (before any state changes in the target)
      if (reenterEnabled && reenterTarget != address(0) && reenterCalldata.length > 0) {
        (bool ok, ) = reenterTarget.call(reenterCalldata);
        require(ok, "reenter call fail");
      }

      // 2) then move funds
      balanceOf[from] -= amt;
      balanceOf[to] += amt;
      emit Transfer(from, to, amt);
      return true;
    }
  }
`;

// Malicious ERC20 that reenters during transfer(...) into a designated target
const REENTER_ON_TRANSFER_SRC = `
  // SPDX-License-Identifier: MIT
  pragma solidity ^0.8.24;

  contract ReenterOnTransfer {
    string public name = "ReenterOnTransfer";
    string public symbol = "ROT2";
    uint8  public decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public reenterTarget;
    bytes   public reenterCalldata;
    bool    public reenterEnabled;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
      balanceOf[msg.sender] = 0;
    }

    function setReenter(address target, bytes calldata data, bool enabled) external {
      reenterTarget = target;
      reenterCalldata = data;
      reenterEnabled = enabled;
    }

    function mint(address to, uint256 amt) external {
      balanceOf[to] += amt;
      emit Transfer(address(0), to, amt);
    }

    function approve(address spender, uint256 amt) external returns (bool) {
      allowance[msg.sender][spender] = amt;
      emit Approval(msg.sender, spender, amt);
      return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
      require(balanceOf[msg.sender] >= amt, "bal");

      // 1) attempt reentrancy before finalizing state move
      if (reenterEnabled && reenterTarget != address(0) && reenterCalldata.length > 0) {
        (bool ok, ) = reenterTarget.call(reenterCalldata);
        require(ok, "reenter call fail");
      }

      // 2) then move funds
      balanceOf[msg.sender] -= amt;
      balanceOf[to] += amt;
      emit Transfer(msg.sender, to, amt);
      return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
      uint256 allow = allowance[from][msg.sender];
      require(allow >= amt, "allow");
      require(balanceOf[from] >= amt, "bal");
      allowance[from][msg.sender] = allow - amt;

      balanceOf[from] -= amt;
      balanceOf[to] += amt;
      emit Transfer(from, to, amt);
      return true;
    }
  }
`;

/*─────────────────────────────────────────────────────────────────────────────*
 * Utilities
 *─────────────────────────────────────────────────────────────────────────────*/

async function mineReenterTokens() {
  const F1 = await ethers.getContractFactoryFromSolidity(REENTER_ON_TRANSFERFROM_SRC);
  const F2 = await ethers.getContractFactoryFromSolidity(REENTER_ON_TRANSFER_SRC);
  const t1 = await F1.deploy(); await t1.waitForDeployment();
  const t2 = await F2.deploy(); await t2.waitForDeployment();
  return { t1, t2 };
}

async function increaseTime(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

/*─────────────────────────────────────────────────────────────────────────────*
 * System deploy (Treasury, Factory, Pool, Hook, Vault, Vesting)
 *─────────────────────────────────────────────────────────────────────────────*/

async function deploySystem() {
  const [deployer, assetReceiver, usdcReceiver, lpMCV, user] = await ethers.getSigners();

  const Treasury = await ethers.getContractFactory("FAFETreasury");
  const treasury = await Treasury.deploy(assetReceiver.address, usdcReceiver.address);
  await treasury.waitForDeployment();

  const Factory  = await ethers.getContractFactory("FAFEFactory");
  const factory  = await Factory.deploy(await treasury.getAddress());
  await factory.waitForDeployment();

  const Vault    = await ethers.getContractFactory("FAFERebateVault");
  const vault    = await Vault.deploy();
  await vault.waitForDeployment();

  const Hook     = await ethers.getContractFactory("FAFEMintHook");
  const hook     = await Hook.deploy(await treasury.getAddress(), await vault.getAddress());
  await hook.waitForDeployment();

  const Vesting  = await ethers.getContractFactory("FAFEVesting");

  // Return handles and signers
  return { deployer, assetReceiver, usdcReceiver, lpMCV, user, treasury, factory, vault, hook, Vesting };
}

/*─────────────────────────────────────────────────────────────────────────────*
 * Test Suite
 *─────────────────────────────────────────────────────────────────────────────*/

describe("Callback / reentrancy safety", () => {
  let deployer: any, lpMCV: any, user: any;
  let treasury: any, factory: any, vault: any, hook: any, Vesting: any;
  let reenterFrom: any, reenterOnTransfer: any;

  before(async () => {
    const sys = await deploySystem();
    ({ deployer, lpMCV, user, treasury, factory, vault, hook, Vesting } = sys);

    const { t1, t2 } = await mineReenterTokens();
    reenterFrom = t1;         // Reenter during transferFrom
    reenterOnTransfer = t2;   // Reenter during transfer
  });

  /*───────────────────────────────────────────────────────────────────────────*
   * 1) Vesting: reenter during payout (transferFrom(vault, beneficiary, amt))
   *   - Expected: NO overpayment (claimed updated before transfer), no revert
   *───────────────────────────────────────────────────────────────────────────*/
  it("FAFEVesting: reentrancy during payout does not overpay", async () => {
    const epochSecs = 60; // short epochs
    const startTime = Math.floor(Date.now() / 1000) - epochSecs * 5; // already several epochs in
    const schedule  = [2500, 2500, 2500, 2500];

    // Use reentrant token as the vested token
    const vestedToken = reenterFrom; // triggers callback on transferFrom(...)
    const Vest = await Vesting.deploy(
      await treasury.getAddress(),
      await vault.getAddress(),     // <- tokens pulled from here
      epochSecs,
      startTime,
      schedule
    );
    await Vest.waitForDeployment();

    // Mint funds to vault; approve Vesting to pull
    const vaultAddr = await vault.getAddress();
    await vestedToken.mint(vaultAddr, ethers.parseEther("1000"));
    await network.provider.send("hardhat_impersonateAccount", [vaultAddr]);
    await network.provider.send("hardhat_setBalance", [vaultAddr, "0x56BC75E2D63100000"]);
    const vaultSigner = await ethers.getSigner(vaultAddr);
    await vestedToken.connect(vaultSigner).approve(await Vest.getAddress(), ethers.MaxUint256);

    // Grant to lpMCV
    const amount = ethers.parseEther("100");
    await Vest.grant(lpMCV.address, await vestedToken.getAddress(), amount);

    // Configure reentry: When Vesting pulls from vault, token re-enters Vest.claim() again
    const claimCalldata = Vest.interface.encodeFunctionData("claim");
    await vestedToken.setReenter(await Vest.getAddress(), claimCalldata, true);

    // Move beyond at least one epoch
    await increaseTime(epochSecs * 2);

    const b0 = await vestedToken.balanceOf(lpMCV.address);
    await Vest.connect(lpMCV).claim(); // triggers token.transferFrom → reenter → claim()
    const b1 = await vestedToken.balanceOf(lpMCV.address);

    // With 2 epochs done (50%), claimant should get exactly 50 tokens; reentry must not pay twice
    const expected = ethers.parseEther("50");
    expect(b1 - b0).to.equal(expected);

    // Disable reentry and claim again after 1 more epoch (75% total)
    await vestedToken.setReenter(ethers.ZeroAddress, "0x", false);
    await increaseTime(epochSecs);
    const b2 = await vestedToken.balanceOf(lpMCV.address);
    await Vest.connect(lpMCV).claim();
    const b3 = await vestedToken.balanceOf(lpMCV.address);

    // Now total vested is 75 → additional 25 should be paid
    expect(b3 - b2).to.equal(ethers.parseEther("25"));
  });

  /*───────────────────────────────────────────────────────────────────────────*
   * 2) Pool: reenter on outbound transfer (transfer to recipient)
   *   - Path: supplicate(...) → transfer(...) → reenter → try to supplicate again
   *   - Expected: No unintended drain; balances consistent
   *───────────────────────────────────────────────────────────────────────────*/
  it("FAFEPool: reentrancy during payout transfer cannot drain reserves", async () => {
    // Deploy a pool with (asset=normal token, usdc=malicious that reenters on transfer)
    const TestERC20 = await ethers.getContractFactory("TestERC20");
    const asset = await TestERC20.deploy("ASSET", "AST", deployer.address);
    const usdc  = await ethers.getContractFactoryFromSolidity(REENTER_ON_TRANSFER_SRC)
      .then(f => f.deploy());
    await asset.waitForDeployment();
    await usdc.waitForDeployment();

    // Allow-list + create pool
    await treasury.allowTokenViaTreasury(await factory.getAddress(), await asset.getAddress(), true);
    await treasury.allowTokenViaTreasury(await factory.getAddress(), await usdc.getAddress(), true);
    const poolAddr = await treasury.createPoolViaTreasury(await factory.getAddress(), await asset.getAddress(), await usdc.getAddress());
    const pool = await ethers.getContractAt("FAFEPool", poolAddr);

    // Hook setup & bootstrap
    await treasury.setPoolHookViaTreasury(await factory.getAddress(), poolAddr, await hook.getAddress());
    const bootstrapA = ethers.parseEther("1000");
    const bootstrapU = ethers.parseEther("1000");

    // Fund treasury, approve hook pull
    await asset.mint(await treasury.getAddress(), bootstrapA);
    await usdc.mint(await treasury.getAddress(), bootstrapU);
    await asset.connect(deployer).approve(await hook.getAddress(), bootstrapA); // approve as deployer? The hook pulls from msg.sender=treasury
    // We must impersonate treasury to approve:
    const treasuryAddr = await treasury.getAddress();
    await network.provider.send("hardhat_impersonateAccount", [treasuryAddr]);
    await network.provider.send("hardhat_setBalance", [treasuryAddr, "0x56BC75E2D63100000"]);
    const treasurySigner = await ethers.getSigner(treasuryAddr);
    await asset.connect(treasurySigner).approve(await hook.getAddress(), bootstrapA);
    await usdc.connect(treasurySigner).approve(await hook.getAddress(), bootstrapU);

    // Bootstrap
    await treasury.connect(treasurySigner).bootstrapViaTreasury(
      await hook.getAddress(),
      poolAddr,
      bootstrapA,
      bootstrapU,
      0
    );

    // User gets some funds and approvals to interact with pool
    const userAmt = ethers.parseEther("100");
    await asset.mint(user.address, userAmt);
    await usdc.mint(user.address,  userAmt);
    await asset.connect(user).approve(poolAddr, userAmt);
    await usdc.connect(user).approve(poolAddr,  userAmt);

    // Configure USDC to reenter pool.supplicate(...) when it transfers funds out to recipient
    const reenterCalldata = pool.interface.encodeFunctionData(
      "supplicate",
      [user.address, user.address, false, ethers.parseEther("1"), 0] // arbitrary second call, likely to revert or no-op
    );
    await usdc.connect(user).setReenter(poolAddr, reenterCalldata, true);

    // Execute a USDC→ASSET swap (assetToUsdc = false means we send USDC, receive Asset)
    const rA0 = await pool.reserveAsset();
    const rU0 = await pool.reserveUsdc();

    await pool.connect(user).supplicate(user.address, user.address, false, ethers.parseEther("10"), 0);

    const rA1 = await pool.reserveAsset();
    const rU1 = await pool.reserveUsdc();

    // Sanity: reserves must reflect a single swap result and NOT be catastrophically drained
    expect(rU1).to.equal(rU0 + ethers.parseEther("10"));
    expect(rA1).to.be.lt(rA0); // we paid asset out

    // Turn off reentrancy and try again, ensure consistent math
    await usdc.connect(user).setReenter(ethers.ZeroAddress, "0x", false);
    const rA2_0 = await pool.reserveAsset();
    const rU2_0 = await pool.reserveUsdc();

    await pool.connect(user).supplicate(user.address, user.address, false, ethers.parseEther("5"), 0);

    const rA2_1 = await pool.reserveAsset();
    const rU2_1 = await pool.reserveUsdc();
    expect(rU2_1).to.equal(rU2_0 + ethers.parseEther("5"));
    expect(rA2_1).to.be.lt(rA2_0);
  });

  /*───────────────────────────────────────────────────────────────────────────*
   * 3) Hook: reenter during mintWithRebate(...) pulls
   *   - Multiple safeTransferFrom calls; we try to reenter pool/burn/etc.
   *   - Expected: no pool drain; liquidity & reserves consistent
   *───────────────────────────────────────────────────────────────────────────*/
  it("FAFEMintHook: reentrancy during mintWithRebate token pulls cannot drain pool/treasury", async () => {
    // Build a fresh asset/usdc pair, but this time make ASSET reenter-on-transferFrom
    const TestERC20 = await ethers.getContractFactory("TestERC20");
    const asset = await ethers.getContractFactoryFromSolidity(REENTER_ON_TRANSFERFROM_SRC)
      .then(f => f.deploy());
    const usdc  = await TestERC20.deploy("USDC", "USDC", deployer.address);
    await asset.waitForDeployment();
    await usdc.waitForDeployment();

    // Allow-list + create pool
    await treasury.allowTokenViaTreasury(await factory.getAddress(), await asset.getAddress(), true);
    await treasury.allowTokenViaTreasury(await factory.getAddress(), await usdc.getAddress(), true);
    const poolAddr = await treasury.createPoolViaTreasury(await factory.getAddress(), await asset.getAddress(), await usdc.getAddress());
    const pool = await ethers.getContractAt("FAFEPool", poolAddr);
    await treasury.setPoolHookViaTreasury(await factory.getAddress(), poolAddr, await hook.getAddress());

    // Bootstrap (impersonate treasury again)
    const treasuryAddr = await treasury.getAddress();
    await network.provider.send("hardhat_impersonateAccount", [treasuryAddr]);
    await network.provider.send("hardhat_setBalance", [treasuryAddr, "0x56BC75E2D63100000"]);
    const treasurySigner = await ethers.getSigner(treasuryAddr);
    const A = ethers.parseEther("1000");
    const U = ethers.parseEther("1000");
    await asset.mint(treasuryAddr, A);
    await usdc.mint(treasuryAddr,  U);
    await asset.connect(treasurySigner).approve(await hook.getAddress(), A);
    await usdc.connect(treasurySigner).approve(await hook.getAddress(),  U);
    await treasury.connect(treasurySigner).bootstrapViaTreasury(await hook.getAddress(), poolAddr, A, U, 0);

    // User deposit with reentering asset token
    const depA = ethers.parseEther("100");
    const depU = ethers.parseEther("100");
    await asset.mint(user.address, depA);
    await usdc.mint(user.address,  depU);
    await asset.connect(user).approve(await hook.getAddress(), depA);
    await usdc.connect(user).approve(await hook.getAddress(),  depU);

    // Configure reentry: when the hook pulls ASSET with transferFrom(user → pool/vault),
    // reenter the pool to try weird stuff (e.g., burn without liquidity, which should revert)
    const badBurnCall = pool.interface.encodeFunctionData("burn", [user.address, ethers.parseEther("1")]);
    await asset.connect(user).setReenter(poolAddr, badBurnCall, true);

    const rA0 = await pool.reserveAsset();
    const rU0 = await pool.reserveUsdc();
    const liq0 = await pool.totalLiquidity();

    // Call hook
    await (await (await ethers.getContractAt("FAFEMintHook", await hook.getAddress()))
      .connect(user)
      .mintWithRebate({
        pool: poolAddr,
        to: user.address,
        amountAssetDesired: depA,
        amountUsdcDesired: depU,
        data: "0x",
      })).wait();

    const rA1 = await pool.reserveAsset();
    const rU1 = await pool.reserveUsdc();
    const liq1 = await pool.totalLiquidity();

    // Sanity: liquidity increased; reserves reflect deposit net of skim
    expect(liq1).to.be.gt(liq0);
    expect(rA1).to.be.gte(rA0);
    expect(rU1).to.be.gte(rU0);

    // Turn off reentry for cleanliness
    await asset.connect(user).setReenter(ethers.ZeroAddress, "0x", false);
  });

  /*───────────────────────────────────────────────────────────────────────────*
   * 4) Placeholders for future callback/hook tests (once added)
   *───────────────────────────────────────────────────────────────────────────*/
  it("Router/Pool callbacks: placeholder to plug malicious callees when hooks land", async () => {
    // When you add pool/router callbacks (e.g., Uniswap-like), we’ll:
    // - deploy MaliciousCallee that reenters into router/pool during callback
    // - assert all invariants (liquidity sum, reserves, claim caps, treasury balances)
    expect(true).to.equal(true);
  });
});