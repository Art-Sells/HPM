// test/shared/externalFixtures.ts
import hre from 'hardhat'
const { ethers } = hre
import type { Signer } from 'ethers'

// Types
import type { IWETH9 } from '../../typechain-types/periphery'
import type { LPPFactory } from '../../typechain-types/protocol'
import type { MockTimeSupplicateRouter } from '../../typechain-types/periphery'

// Load JSON artifacts via createRequire (robust in Hardhat/TS)
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const WETH9 = require('../contracts/WETH9.json')
const LPP_FACTORY_ARTIFACT = require('@lpp/lpp-protocol/artifacts/contracts/LPPFactory.sol/LPPFactory.json')
const ROUTER_ARTIFACT = require('../../artifacts/contracts/test/MockTimeSupplicateRouter.sol/MockTimeSupplicateRouter.json')

// -------------------- generic helper --------------------
async function deployFromArtifact<T>(
  artifact: { abi: any; bytecode: string },
  signer: Signer,
  args: unknown[] = []
): Promise<T> {
  const F = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer)
  const c = (await F.deploy(...args)) as any
  await c.waitForDeployment()
  return c as T
}

// -------------------- WETH9 --------------------
export async function wethFixture([wallet]: Signer[], _provider?: unknown): Promise<{ weth9: IWETH9 }> {
  const weth9 = await deployFromArtifact<IWETH9>(WETH9, wallet)
  return { weth9 }
}

// -------------------- LPP Core Factory --------------------
// Supports both constructor() and constructor(address owner)
export async function lppFactoryFixture([wallet]: Signer[], _provider?: unknown): Promise<LPPFactory> {
  const ctorInputs =
    (Array.isArray(LPP_FACTORY_ARTIFACT.abi)
      ? LPP_FACTORY_ARTIFACT.abi.find((x: any) => x && x.type === 'constructor')?.inputs
      : null) || []

  let args: unknown[] = []
  if (ctorInputs.length === 1) {
    // assume constructor(address owner)
    args = [await wallet.getAddress()]
  } else if (ctorInputs.length > 1) {
    throw new Error(`Unexpected LPPFactory constructor arity: ${ctorInputs.length}`)
  }

  const factory = await deployFromArtifact<LPPFactory>(LPP_FACTORY_ARTIFACT, wallet, args)
  return factory
}

// -------------------- LPP Router Fixture --------------------
export async function lppRouterFixture(
  [wallet]: Signer[],
  provider?: unknown
): Promise<{ weth9: IWETH9; factory: LPPFactory; router: MockTimeSupplicateRouter }> {
  const { weth9 } = await wethFixture([wallet], provider)
  const factory = await lppFactoryFixture([wallet], provider)

  const router = await deployFromArtifact<MockTimeSupplicateRouter>(
    ROUTER_ARTIFACT,
    wallet,
    [await factory.getAddress(), await weth9.getAddress()]
  )

  return { factory, weth9, router }
}