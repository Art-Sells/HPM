// test/shared/externalFixtures.ts
import { ethers } from 'hardhat'
import type { Signer } from 'ethers'

// Pull strong types (interfaces) for the return values
import {
  ILPPFactory,
} from '../../typechain-types/protocol'
import {
  IWETH9,
  MockTimeSupplicateRouter,
  // We import factories ONLY to access `abi` and `bytecode`
  IWETH9__factory,
  MockTimeSupplicateRouter__factory,
} from '../../typechain-types/periphery'
import {
  ILPPFactory__factory,
} from '../../typechain-types/protocol'

// -------------------- helpers --------------------
async function deployWithTypechainArtifact<T>(
  factoryAbi: any[],
  factoryBytecode: string,
  signer: Signer,
  args: unknown[] = []
): Promise<T> {
  const cf = new ethers.ContractFactory(factoryAbi, factoryBytecode, signer)
  const c = (await cf.deploy(...args)) as any
  await c.waitForDeployment()
  return c as T
}

// -------------------- WETH9 --------------------
export async function wethFixture(): Promise<{ weth9: IWETH9 }> {
  const [deployer] = await ethers.getSigners()
  const weth9 = await deployWithTypechainArtifact<IWETH9>(
    IWETH9__factory.abi,
    IWETH9__factory.bytecode,
    deployer
  )
  return { weth9 }
}

// -------------------- LPP Core Factory (only) --------------------
export async function lppFactoryFixture(): Promise<ILPPFactory> {
  const [deployer] = await ethers.getSigners()
  const lppFactory = await deployWithTypechainArtifact<ILPPFactory>(
    ILPPFactory__factory.abi,
    ILPPFactory__factory.bytecode,
    deployer,
    /* ctor args if any: [] */
  )
  return lppFactory
}

// -------------------- LPP Router Fixture --------------------
export async function lppRouterFixture(): Promise<{
  weth9: IWETH9
  factory: ILPPFactory
  router: MockTimeSupplicateRouter
}> {
  const [deployer] = await ethers.getSigners()

  const { weth9 } = await wethFixture()
  const factory = await lppFactoryFixture()

  const factoryAddr = await factory.getAddress()
  const wethAddr = await weth9.getAddress()

  const router = await deployWithTypechainArtifact<MockTimeSupplicateRouter>(
    MockTimeSupplicateRouter__factory.abi,
    MockTimeSupplicateRouter__factory.bytecode,
    deployer,
    [factoryAddr, wethAddr]
  )

  return { factory, weth9, router }
}