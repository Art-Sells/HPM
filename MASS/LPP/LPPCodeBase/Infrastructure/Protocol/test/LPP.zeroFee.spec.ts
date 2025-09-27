import { expect } from "chai";
import { ethers } from "ethers"; 

// BigInt helpers
const Q96 = 1n << 96n;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const SQRT_PRICE_1_TO_1 = Q96;

const TICK_LOWER = -887270;
const TICK_UPPER =  887270;

describe("LPP fee=0 tier", () => {
  it("enables fee=0, mints, swaps, and accrues zero fees", async () => {
    const [deployer, lp, trader] = await ethers.getSigners();

    // Deploy two ERC20 test tokens (assumes decimals=18 in TestERC20)
    const TestERC20 = await ethers.getContractFactory("TestERC20", deployer);
    const token0 = await TestERC20.deploy(10n ** 24n);
    const token1 = await TestERC20.deploy(10n ** 24n);
    await token0.waitForDeployment();
    await token1.waitForDeployment();

    // Deploy pool infra
    const PoolDeployer = await ethers.getContractFactory("LPPPoolDeployer", deployer);
    const poolDeployer = await PoolDeployer.deploy();
    await poolDeployer.waitForDeployment();

    const Factory = await ethers.getContractFactory("LPPFactory", deployer);
    const factory = await Factory.deploy(await poolDeployer.getAddress());
    await factory.waitForDeployment();

    // Wire factory into poolDeployer
    await (await poolDeployer.setFactory(await factory.getAddress())).wait();

    // Enable fee=0 with tickSpacing=5
    await (await factory.enableFeeAmount(0, 5)).wait();

    // Create pool (fee=0)
    await (await factory.createPool(await token0.getAddress(), await token1.getAddress(), 0)).wait();
    const poolAddr = await factory.getPool(await token0.getAddress(), await token1.getAddress(), 0);
    const pool = await ethers.getContractAt("LPPPool", poolAddr, deployer);

    // Initialize 1:1
    await (await pool.initialize(SQRT_PRICE_1_TO_1)).wait();

    // Deploy callee
    const Callee = await ethers.getContractFactory("TestLPPCallee", deployer);
    const callee = await Callee.deploy();
    await callee.waitForDeployment();

    // Fund LP & approve
    const amount0Desired = 10n ** 21n; // 1,000 * 1e18
    const amount1Desired = 10n ** 21n;
    await (await token0.transfer(lp.address, amount0Desired)).wait();
    await (await token1.transfer(lp.address, amount1Desired)).wait();
    await (await token0.connect(lp).approve(await callee.getAddress(), amount0Desired)).wait();
    await (await token1.connect(lp).approve(await callee.getAddress(), amount1Desired)).wait();

    // Mint wide
    await (await callee.connect(lp).mint(
      await pool.getAddress(),
      lp.address,
      TICK_LOWER,
      TICK_UPPER,
      amount0Desired,
      amount1Desired
    )).wait();

    // Pre-swap fee growth & protocol fees
    const fee0Before = await pool.feeGrowthGlobal0X128();
    const fee1Before = await pool.feeGrowthGlobal1X128();
    const protoBefore = await pool.protocolFees();
    const before0 = (protoBefore as any).token0 ?? protoBefore[0];
    const before1 = (protoBefore as any).token1 ?? protoBefore[1];

    // Trader gets token0 and approves
    const amountIn = 10n ** 18n;
    await (await token0.transfer(trader.address, amountIn)).wait();
    await (await token0.connect(trader).approve(await callee.getAddress(), amountIn)).wait();

    // Swap exact0For1 with fee=0
    await (await callee.connect(trader).swapExact0For1(
      await pool.getAddress(),
      amountIn,
      MIN_SQRT_RATIO + 1n
    )).wait();

    // Post-swap checks
    const fee0After = await pool.feeGrowthGlobal0X128();
    const fee1After = await pool.feeGrowthGlobal1X128();
    const protoAfter = await pool.protocolFees();
    const after0 = (protoAfter as any).token0 ?? protoAfter[0];
    const after1 = (protoAfter as any).token1 ?? protoAfter[1];

    expect(fee0After).to.equal(fee0Before, "feeGrowthGlobal0X128 changed at fee=0");
    expect(fee1After).to.equal(fee1Before, "feeGrowthGlobal1X128 changed at fee=0");
    expect(after0).to.equal(before0, "protocolFees.token0 changed at fee=0");
    expect(after1).to.equal(before1, "protocolFees.token1 changed at fee=0");
  });
});