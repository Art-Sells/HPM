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

// Optional TypeChain types if you generated them locally; safe to keep the casts.
import type {
  ILPPFactory,
  LPPRebateVault,
  LPPTreasury,
  LPPMintHook,
} from '../../typechain-types/protocol'

import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const VAULT_ART  = require('@lpp/lpp-protocol/artifacts/contracts/rebates/LPPRebateVault.sol/LPPRebateVault.json')
const TREAS_ART  = require('@lpp/lpp-protocol/artifacts/contracts/rebates/LPPTreasury.sol/LPPTreasury.json')
const HOOK_ART   = require('@lpp/lpp-protocol/artifacts/contracts/rebates/LPPMintHook.sol/LPPMintHook.json')

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

// Reattach helper that avoids Hardhat artifact lookup
function reattach<T = Contract>(abi: any, address: string, signer: any): T {
  return new ethers.Contract(address, abi, signer) as unknown as T
}

type CompleteFixture = {
  weth9: IWETH9
  factory: ILPPFactory
  router: MockTimeSupplicateRouter
  tokens: [TestERC20, TestERC20, TestERC20]
  nftDescriptor: NonfungibleTokenPositionDescriptor
  nft: MockTimeNonfungiblePositionManager
  vault: LPPRebateVault
  treasury: LPPTreasury
  hook: LPPMintHook
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
  // Test tokens
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
  // Deploy LPP Vault / Treasury / Hook via external artifacts (no getContractAt)
  // ────────────────────────────────────────────────────────────────────────────
  const vaultDep = await deployFromArtifact(VAULT_ART, wallet, [await wallet.getAddress()])
  const treasuryDep = await deployFromArtifact(TREAS_ART, wallet, [await wallet.getAddress()])

  const hookDep = await deployFromArtifact(HOOK_ART, wallet, [
    await vaultDep.getAddress(),
    await treasuryDep.getAddress(),
  ])

  // Reattach with external ABIs to get a nice typed surface without HH artifacts
  const vault   = reattach<LPPRebateVault>(VAULT_ART.abi,   await vaultDep.getAddress(),   wallet)
  const treasury= reattach<LPPTreasury>(TREAS_ART.abi,      await treasuryDep.getAddress(),wallet)
  const hook    = reattach<LPPMintHook>(HOOK_ART.abi,       await hookDep.getAddress(),    wallet)

  // Wire hook to factory if supported
  try {
    await (factory as any).setDefaultMintHook(await hook.getAddress())
  } catch {
    // factory may not expose it in some builds
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Approvals for NPM + Hook
  // ────────────────────────────────────────────────────────────────────────────
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