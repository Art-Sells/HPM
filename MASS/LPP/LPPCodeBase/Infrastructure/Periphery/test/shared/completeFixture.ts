// test/shared/completeFixture.ts
import hre from 'hardhat'
const { ethers } = hre

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { MaxUint256, Contract } from 'ethers'

import { lppRouterFixture } from './externalFixtures.ts'

import type {
  IWETH9,
  MockTimeSupplicateRouter,
  MockTimeNonfungiblePositionManager,
  NonfungibleTokenPositionDescriptor,
  TestERC20,
} from '../../typechain-types/periphery'

// Keep using the periphery’s ILPPFactory TypeChain (this one exists)
import type { ILPPFactory } from '../../typechain-types/protocol'

/** Load JSON artifacts via createRequire (robust in Hardhat/TS) */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

// ── Protocol artifacts (NOTE: paths include /rebates/ in your tree)
const VAULT_ART  = require('@lpp/lpp-protocol/artifacts/contracts/rebates/LPPRebateVault.sol/LPPRebateVault.json')
const TREAS_ART  = require('@lpp/lpp-protocol/artifacts/contracts/rebates/LPPTreasury.sol/LPPTreasury.json')
const HOOK_ART   = require('@lpp/lpp-protocol/artifacts/contracts/rebates/LPPMintHook.sol/LPPMintHook.json')

// Small helper to deploy from a JSON artifact
async function deployFromArtifact<T extends Contract = Contract>(
  artifact: { abi: any; bytecode: string },
  signer: any,
  args: unknown[] = []
): Promise<T> {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer)
  const contract = (await factory.deploy(...args)) as Contract
  await contract.waitForDeployment()
  return contract as T
}

type CompleteFixture = {
  weth9: IWETH9
  factory: ILPPFactory
  router: MockTimeSupplicateRouter
  tokens: [TestERC20, TestERC20, TestERC20]
  nftDescriptor: NonfungibleTokenPositionDescriptor
  nft: MockTimeNonfungiblePositionManager
  vault: Contract
  treasury: Contract
  hook: Contract
}

export default async function completeFixture(
  [wallet]: SignerWithAddress[],
  provider: any
): Promise<CompleteFixture> {
  const { weth9, factory, router } = await lppRouterFixture([wallet], provider)

  // Ensure the fee tier used by tests is enabled (fee=0, spacing=60)
  const ZERO_FEE = 0
  const TEST_TICK_SPACING = 60
  const current = await factory.feeAmountTickSpacing(ZERO_FEE)
  if (current === 0n) {
    await factory.enableFeeAmount(ZERO_FEE, BigInt(TEST_TICK_SPACING))
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Test tokens (cast each deploy to TestERC20 to satisfy TS)
  // ────────────────────────────────────────────────────────────────────────────
  const tokenFactory = await ethers.getContractFactory('TestERC20')
  const half = MaxUint256 / 2n

  const t0 = (await tokenFactory.deploy(half)) as unknown as TestERC20
  const t1 = (await tokenFactory.deploy(half)) as unknown as TestERC20
  const t2 = (await tokenFactory.deploy(half)) as unknown as TestERC20
  await Promise.all([t0.waitForDeployment(), t1.waitForDeployment(), t2.waitForDeployment()])

  const tokens = [t0, t1, t2] as [TestERC20, TestERC20, TestERC20]
  tokens.sort((a, b) => (String(a.target).toLowerCase() < String(b.target).toLowerCase() ? -1 : 1))

  // ────────────────────────────────────────────────────────────────────────────
  // NFT Descriptor stack
  // ────────────────────────────────────────────────────────────────────────────
  const nftDescLibFactory = await ethers.getContractFactory('NFTDescriptor')
  const nftDescLib = await nftDescLibFactory.deploy()
  await nftDescLib.waitForDeployment()

  const positionDescriptorFactory = await ethers.getContractFactory('NonfungibleTokenPositionDescriptor', {
    libraries: { NFTDescriptor: String(nftDescLib.target) },
  })
  const nftDescriptor = (await positionDescriptorFactory.deploy(
    String(weth9.target),
    ethers.encodeBytes32String('ETH')
  )) as unknown as NonfungibleTokenPositionDescriptor
  await nftDescriptor.waitForDeployment()

  const positionManagerFactory = await ethers.getContractFactory('MockTimeNonfungiblePositionManager')
  const nft = (await positionManagerFactory.deploy(
    String(factory.target),
    String(weth9.target),
    String(nftDescriptor.target)
  )) as unknown as MockTimeNonfungiblePositionManager
  await nft.waitForDeployment()

  // ────────────────────────────────────────────────────────────────────────────
  // Deploy LPP Vault / Treasury / Hook via require() artifacts
  // ────────────────────────────────────────────────────────────────────────────
  const vault = await deployFromArtifact<Contract>(VAULT_ART, wallet, [await wallet.getAddress()])
  const treasury = await deployFromArtifact<Contract>(TREAS_ART, wallet, [await wallet.getAddress()])
  const hook = await deployFromArtifact<Contract>(HOOK_ART, wallet, [
    await vault.getAddress(),
    await treasury.getAddress(),
  ])

  // Try wiring hook to factory (ignore if factory doesn’t expose it)
  try {
    await (factory as any).setDefaultMintHook(await hook.getAddress())
  } catch {
    // ignore
  }

  // Approvals for NPM + Hook
  const nftAddr = await nft.getAddress()
  const hookAddr = await hook.getAddress()
  const [, other] = await ethers.getSigners()

  for (const t of tokens) {
    await t.approve(nftAddr, MaxUint256)
    await t.approve(hookAddr, MaxUint256)
    await t.connect(other).approve(nftAddr, MaxUint256)
    await t.connect(other).approve(hookAddr, MaxUint256)
  }

  return {
    weth9,
    factory,
    router,
    tokens,
    nftDescriptor,
    nft,
    vault,
    treasury,
    hook,
  }
}