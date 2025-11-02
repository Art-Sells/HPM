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
// We REQUIRE constructor(address _mintHook). If your artifact differs, this will throw.
export async function lppFactoryFixture(
  [wallet]: Signer[],
  _provider: unknown,
  opts: { mintHook: string }
): Promise<LPPFactory> {
  if (!opts?.mintHook) throw new Error('lppFactoryFixture: opts.mintHook is required')

  const ctorInputs =
    (Array.isArray(LPP_FACTORY_ARTIFACT.abi)
      ? LPP_FACTORY_ARTIFACT.abi.find((x: any) => x && x.type === 'constructor')?.inputs
      : null) || []

  if (ctorInputs.length !== 1) {
    throw new Error(
      `LPPFactory constructor must accept exactly one arg (mintHook). Found ${ctorInputs.length}. ` +
      `Please ensure your LPPFactory has constructor(address _mintHook).`
    )
  }

  const factory = await deployFromArtifact<LPPFactory>(LPP_FACTORY_ARTIFACT, wallet, [opts.mintHook])
  return factory
}

// -------------------- LPP Router Fixture --------------------
export async function lppRouterFixture(
  [wallet]: Signer[],
  provider: unknown,
  opts: { mintHook: string }
): Promise<{ weth9: IWETH9; factory: LPPFactory; router: MockTimeSupplicateRouter }> {
  const { weth9 } = await wethFixture([wallet], provider)
  const factory = await lppFactoryFixture([wallet], provider, { mintHook: opts.mintHook })

  const router = await deployFromArtifact<MockTimeSupplicateRouter>(
    ROUTER_ARTIFACT,
    wallet,
    [await factory.getAddress(), await weth9.getAddress()]
  )

  return { factory, weth9, router }
}