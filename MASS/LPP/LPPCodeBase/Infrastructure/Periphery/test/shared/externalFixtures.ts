// test/shared/externalFixtures.ts
import { ethers } from "hardhat"
import type { Signer } from "ethers"

import type { IWETH9 } from "../../typechain-types/periphery"
import type { LPPFactory } from "../../typechain-types/protocol"
import type { MockTimeSupplicateRouter } from "../../typechain-types/periphery"

import WETH9 from "../contracts/WETH9.json"
import LPP_FACTORY_ARTIFACT from "@lpp/lpp-protocol/artifacts/contracts/LPPFactory.sol/LPPFactory.json"
import ROUTER_ARTIFACT from "../../artifacts/contracts/test/MockTimeSupplicateRouter.sol/MockTimeSupplicateRouter.json"

// -------------------- helper --------------------
async function deployFromArtifact<T>(
  artifact: { abi: any; bytecode: string },
  signer: Signer,
  args: unknown[] = []
): Promise<T> {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer)
  const contract = (await factory.deploy(...args)) as any
  await contract.waitForDeployment()
  return contract as T
}

// -------------------- WETH9 --------------------
export async function wethFixture([wallet]: Signer[], _provider?: any): Promise<{ weth9: IWETH9 }> {
  const weth9 = await deployFromArtifact<IWETH9>(WETH9 as any, wallet)
  return { weth9 }
}

// -------------------- LPP Core Factory --------------------
export async function lppFactoryFixture([wallet]: Signer[], _provider?: any): Promise<LPPFactory> {
  const factory = await deployFromArtifact<LPPFactory>(LPP_FACTORY_ARTIFACT as any, wallet)
  return factory
}

// -------------------- LPP Router Fixture --------------------
export async function lppRouterFixture(
  [wallet]: Signer[],
  provider?: any
): Promise<{
  weth9: IWETH9
  factory: LPPFactory
  router: MockTimeSupplicateRouter
}> {
  const { weth9 } = await wethFixture([wallet], provider)
  const factory = await lppFactoryFixture([wallet], provider)

  const router = await deployFromArtifact<MockTimeSupplicateRouter>(
    ROUTER_ARTIFACT as any,
    wallet,
    [await factory.getAddress(), await weth9.getAddress()]
  )

  return { factory, weth9, router }
}