import hardhat from "hardhat";
import { expect } from "chai";
const { ethers, artifacts } = hardhat;

const Q96 = 1n << 96n;
const MIN_SQRT_RATIO = 4295128739n;
const SQRT_PRICE_1_TO_1 = Q96;
const TICK_LOWER = -887270;
const TICK_UPPER =  887270;
const LIQ = 10n ** 12n; 

// ---------- helpers ----------
async function factoryOf(name: string, s: any) {
  return ethers.getContractFactory(name, s);
}

// Deploy, but only pass as many args as ctor actually takes
async function deploy(name: string, s: any, ...maybeArgs: any[]) {
  const F = await factoryOf(name, s);
  const art = await artifacts.readArtifact(name);
  const ctor = (art.abi as any[]).find(f => f.type === "constructor");
  const n = ctor?.inputs?.length ?? 0;
  const args = maybeArgs.slice(0, n);
  const c = await F.deploy(...args);
  await c.waitForDeployment();
  return c as any;
}

async function attach(name: string, addr: string, s: any) {
  const F = await factoryOf(name, s);
  return F.attach(addr) as any;
}

describe("LPP fee=0 tier (hardhat ethers v6)", () => {
  it("enables fee=0, mints, supplicates, and accrues zero fees", async () => {
    const [deployer, lp, trader] = await ethers.getSigners();

    // tokens
    const token0 = await deploy("TestERC20", deployer, 10n ** 24n);
    const token1 = await deploy("TestERC20", deployer, 10n ** 24n);

    // core
    const poolDeployer = await deploy("LPPPoolDeployer", deployer);

    const factory = await deploy(
      "LPPFactory",
      deployer,
      await poolDeployer.getAddress()
    );

    // If your design *also* exposes a setter on either side, wire it optionally:
    if (typeof factory.setPoolDeployer === "function") {
      await (await factory.connect(deployer).setPoolDeployer(
        await poolDeployer.getAddress()
      )).wait();
    }

    // enable fee=0
    await (await factory.connect(deployer).enableFeeAmount(0, 5)).wait();

    // create pool
    await (await factory.connect(deployer).createPool(
      await token0.getAddress(),
      await token1.getAddress(),
      0
    )).wait();

    const poolAddr = await factory.getPool(
      await token0.getAddress(),
      await token1.getAddress(),
      0
    );
    const pool = await attach("LPPPool", poolAddr, deployer);

    // init 1:1
    await (await pool.connect(deployer).initialize(SQRT_PRICE_1_TO_1)).wait();

    // callee
    const callee = await deploy("TestLPPCallee", deployer);

    // fund + approve
    const amount0Desired = 10n ** 21n;
    const amount1Desired = 10n ** 21n;
    await (await token0.connect(deployer).transfer(await lp.getAddress(), amount0Desired)).wait();
    await (await token1.connect(deployer).transfer(await lp.getAddress(), amount1Desired)).wait();
    await (await token0.connect(lp).approve(await callee.getAddress(), amount0Desired)).wait();
    await (await token1.connect(lp).approve(await callee.getAddress(), amount1Desired)).wait();


    // pre-supplication fee growth
    const fee0Before  = await pool.feeGrowthGlobal0X128();
    const fee1Before  = await pool.feeGrowthGlobal1X128();
    const protoBefore = await pool.protocolFees();
    const before0 = (protoBefore as any).token0 ?? protoBefore[0];
    const before1 = (protoBefore as any).token1 ?? protoBefore[1];

    // MASS supplication
    const amountIn = 10n ** 18n;
    await (await token0.connect(deployer).transfer(await trader.getAddress(), amountIn)).wait();
    await (await token0.connect(trader).approve(await callee.getAddress(), amountIn)).wait();
    await (await callee
      .connect(lp)
      ["mint(address,address,int24,int24,uint128)"](
        await pool.getAddress(),
        await lp.getAddress(),
        TICK_LOWER,
        TICK_UPPER,
        LIQ
      )
    ).wait();

    // post-supplication checks (fee=0 → unchanged)
    const fee0After  = await pool.feeGrowthGlobal0X128();
    const fee1After  = await pool.feeGrowthGlobal1X128();
    const protoAfter = await pool.protocolFees();
    const after0 = (protoAfter as any).token0 ?? protoAfter[0];
    const after1 = (protoAfter as any).token1 ?? protoAfter[1];

    expect(fee0After).to.equal(fee0Before);
    expect(fee1After).to.equal(fee1Before);
    expect(after0).to.equal(before0);
    expect(after1).to.equal(before1);
  });
});