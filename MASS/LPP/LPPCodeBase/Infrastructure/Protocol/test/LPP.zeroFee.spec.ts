import { expect } from "chai";
import { ethers } from "ethers";
import hre from "hardhat";

const provider = new ethers.BrowserProvider((hre as any).network.provider);
const signer = (i: number) => provider.getSigner(i);

const Q96 = 1n << 96n;
const MIN_SQRT_RATIO = 4295128739n;
const SQRT_PRICE_1_TO_1 = Q96;

const TICK_LOWER = -887270;
const TICK_UPPER =  887270;

// --- helpers ---
async function deployFromArtifact(name: string, s: ethers.Signer, ...args: any[]) {
  const art = await hre.artifacts.readArtifact(name);
  const f = new ethers.ContractFactory(art.abi, art.bytecode, s);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c as ethers.Contract;
}

async function at(name: string, addr: string, s: ethers.Signer) {
  const art = await hre.artifacts.readArtifact(name);
  return new ethers.Contract(addr, art.abi, s) as ethers.Contract;
}
// ---------------

describe("LPP fee=0 tier (raw ethers)", () => {
  it("enables fee=0, mints, swaps, and accrues zero fees", async () => {
    const deployer = await signer(0);
    const lp       = await signer(1);
    const trader   = await signer(2);

    const token0 = await deployFromArtifact("TestERC20", deployer, 10n ** 24n) as any;
    const token1 = await deployFromArtifact("TestERC20", deployer, 10n ** 24n) as any;

    const poolDeployer = await deployFromArtifact("LPPPoolDeployer", deployer) as any;
    const factory      = await deployFromArtifact("LPPFactory", deployer, await poolDeployer.getAddress()) as any;

    await (poolDeployer as any).setFactory(await factory.getAddress());
    await (factory as any).enableFeeAmount(0, 5);
    await (factory as any).createPool(await token0.getAddress(), await token1.getAddress(), 0);

    const poolAddr: string = await (factory as any).getPool(
      await token0.getAddress(),
      await token1.getAddress(),
      0
    );
    const pool = await at("LPPPool", poolAddr, deployer) as any;

    await (pool as any).initialize(SQRT_PRICE_1_TO_1);

    const callee = await deployFromArtifact("TestLPPCallee", deployer) as any;

    const amount0Desired = 10n ** 21n;
    const amount1Desired = 10n ** 21n;

    await (token0 as any).transfer(await lp.getAddress(), amount0Desired);
    await (token1 as any).transfer(await lp.getAddress(), amount1Desired);

    await (token0 as any).connect(lp).approve(await callee.getAddress(), amount0Desired);
    await (token1 as any).connect(lp).approve(await callee.getAddress(), amount1Desired);

    await (callee as any).mint(
      await pool.getAddress(),
      await lp.getAddress(),
      TICK_LOWER,
      TICK_UPPER,
      amount0Desired,
      amount1Desired
    );

    const fee0Before = await (pool as any).feeGrowthGlobal0X128();
    const fee1Before = await (pool as any).feeGrowthGlobal1X128();
    const protoBefore = await (pool as any).protocolFees();
    const before0 = (protoBefore as any).token0 ?? protoBefore[0];
    const before1 = (protoBefore as any).token1 ?? protoBefore[1];

    const amountIn = 10n ** 18n;
    await (token0 as any).transfer(await trader.getAddress(), amountIn);
    await (token0 as any).connect(trader).approve(await callee.getAddress(), amountIn);

    await (callee as any).swapExact0For1(
      await pool.getAddress(),
      amountIn,
      MIN_SQRT_RATIO + 1n
    );

    const fee0After = await (pool as any).feeGrowthGlobal0X128();
    const fee1After = await (pool as any).feeGrowthGlobal1X128();
    const protoAfter = await (pool as any).protocolFees();
    const after0 = (protoAfter as any).token0 ?? protoAfter[0];
    const after1 = (protoAfter as any).token1 ?? protoAfter[1];

    expect(fee0After).to.equal(fee0Before, "feeGrowthGlobal0X128 changed at fee=0");
    expect(fee1After).to.equal(fee1Before, "feeGrowthGlobal1X128 changed at fee=0");
    expect(after0).to.equal(before0, "protocolFees.token0 changed at fee=0");
    expect(after1).to.equal(before1, "protocolFees.token1 changed at fee=0");
  });
});