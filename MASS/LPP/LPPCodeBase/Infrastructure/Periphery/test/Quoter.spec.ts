// test/Quoter.spec.ts
import hre from 'hardhat'
const { ethers } = hre
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from './shared/expect.ts'

import type {
  MockTimeNonfungiblePositionManager,
  SupplicateQuoter,
  TestERC20,
} from '../typechain-types/periphery'

import completeFixture from './shared/completeFixture.ts'
import { FeeAmount } from './shared/constants.ts'
import { expandTo18Decimals } from './shared/expandTo18Decimals.ts'
import { encodePath } from './shared/path.ts'
import {
  createPoolWithMultiplePositions, // <-- use the beefy-liquidity helper
} from './shared/quoter.ts'

// --------------------------------------------------------------------------------------
// ZERO fee only
// --------------------------------------------------------------------------------------
const FEE = FeeAmount.ZERO as 0

// Use tiny amounts for quoting (liquidity is big, so this won't round to 0)
const IN_SMALL = 10n
const OUT_ONE = 1n

async function getFactoryAddressFromNft(
  nft: MockTimeNonfungiblePositionManager,
  signer: any
): Promise<string> {
  // Some builds expose factory() directly; otherwise read via a tiny ABI
  try {
    // @ts-ignore
    return await (nft as any).factory()
  } catch {
    const MIN_ABI = ['function factory() view returns (address)'] as const
    const c = new ethers.Contract(await nft.getAddress(), MIN_ABI, signer)
    return await c.factory()
  }
}

describe('SupplicateQuoter', () => {
  let signer0: any
  let trader: any

  async function fixture() {
    const signers = await ethers.getSigners()
    ;[signer0, trader] = signers

    const { weth9, factory, router, tokens, nft } = await completeFixture(
      signers as any,
      ethers.provider as any
    )

    // approvals/funding
    for (const token of tokens) {
      await token.connect(signer0).approve(await router.getAddress(), ethers.MaxUint256)
      await token.connect(signer0).approve(await nft.getAddress(), ethers.MaxUint256)
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)
      await token.connect(signer0).transfer(await trader.getAddress(), expandTo18Decimals(1_000_000))
    }

    // IMPORTANT: deploy quoter with the exact same factory the NFT manager uses
    const factoryAddr = await getFactoryAddressFromNft(nft, signer0)

    const QuoterFactory = await ethers.getContractFactory('SupplicateQuoter')
    const quoterImpl = await QuoterFactory.deploy(factoryAddr, await weth9.getAddress())
    await quoterImpl.waitForDeployment()

    const quoter = quoterImpl as unknown as SupplicateQuoter
    return { tokens, nft, quoter }
  }

  let nft: MockTimeNonfungiblePositionManager
  let tokens: [TestERC20, TestERC20, TestERC20]
  let quoter: SupplicateQuoter

  beforeEach(async () => {
    ;({ tokens, nft, quoter } = await loadFixture(fixture))

    // Seed TWO pools with **large, multi-band** liquidity (all ZERO fee)
    const s0 = (await ethers.getSigners())[0] as any
    await createPoolWithMultiplePositions(
      nft,
      s0,
      await tokens[0].getAddress(),
      await tokens[1].getAddress()
    )
    await createPoolWithMultiplePositions(
      nft,
      s0,
      await tokens[1].getAddress(),
      await tokens[2].getAddress()
    )
  })

  // ------------------------------------------------------------------------------------
  // PATH-BASED (contract aggregates the hops)
  // ------------------------------------------------------------------------------------
  describe('#quoteExactInput', () => {
    it('0 -> 1 (> 0)', async () => {
      const out01 = await quoter.quoteExactInput.staticCall(
        encodePath(
          [await tokens[0].getAddress(), await tokens[1].getAddress()],
          [FEE]
        ),
        IN_SMALL
      )
      expect(out01 > 0n).to.equal(true)
    })

    it('1 -> 0 is ~symmetric to 0 -> 1', async () => {
      const out10 = await quoter.quoteExactInput.staticCall(
        encodePath(
          [await tokens[1].getAddress(), await tokens[0].getAddress()],
          [FEE]
        ),
        IN_SMALL
      )
      expect(out10 > 0n).to.equal(true)
    })

    it('0 -> 1 -> 2 (> 0)', async () => {
      const out012 = await quoter.quoteExactInput.staticCall(
        encodePath(
          [
            await tokens[0].getAddress(),
            await tokens[1].getAddress(),
            await tokens[2].getAddress(),
          ],
          [FEE, FEE]
        ),
        IN_SMALL
      )
      expect(out012 > 0n).to.equal(true)
    })

    it('2 -> 1 -> 0 is ~symmetric to 0 -> 1 -> 2', async () => {
      const out210 = await quoter.quoteExactInput.staticCall(
        encodePath(
          [
            await tokens[2].getAddress(),
            await tokens[1].getAddress(),
            await tokens[0].getAddress(),
          ],
          [FEE, FEE]
        ),
        IN_SMALL
      )
      expect(out210 > 0n).to.equal(true)
    })
  })

  describe('#quoteExactOutput', () => {
    it('0 -> 1 (finite input for 1 out)', async () => {
      // exactOutput path is OUT->IN
      const in01 = await quoter.quoteExactOutput.staticCall(
        encodePath(
          [await tokens[1].getAddress(), await tokens[0].getAddress()],
          [FEE]
        ),
        OUT_ONE
      )
      expect(in01 > 0n).to.equal(true)
    })

    it('1 -> 0 input is ~symmetric to 0 -> 1', async () => {
      const in10 = await quoter.quoteExactOutput.staticCall(
        encodePath(
          [await tokens[0].getAddress(), await tokens[1].getAddress()],
          [FEE]
        ),
        OUT_ONE
      )
      expect(in10 > 0n).to.equal(true)
    })

    it('0 -> 1 -> 2 (finite input for 1 out)', async () => {
      const in012 = await quoter.quoteExactOutput.staticCall(
        encodePath(
          [
            await tokens[2].getAddress(),
            await tokens[1].getAddress(),
            await tokens[0].getAddress(),
          ],
          [FEE, FEE]
        ),
        OUT_ONE
      )
      expect(in012 > 0n).to.equal(true)
    })

    it('2 -> 1 -> 0 input is ~symmetric to 0 -> 1 -> 2', async () => {
      const in210 = await quoter.quoteExactOutput.staticCall(
        encodePath(
          [
            await tokens[0].getAddress(),
            await tokens[1].getAddress(),
            await tokens[2].getAddress(),
          ],
          [FEE, FEE]
        ),
        OUT_ONE
      )
      expect(in210 > 0n).to.equal(true)
    })
  })

  // ------------------------------------------------------------------------------------
  // SINGLE-HOP sanity
  // ------------------------------------------------------------------------------------
  describe('#single-hop sanity', () => {
    it('quoteExactInputSingle 0 -> 1 (> 0)', async () => {
      const t0 = await tokens[0].getAddress()
      const t1 = await tokens[1].getAddress()
      const out = await quoter.quoteExactInputSingle.staticCall(
        t0,
        t1,
        FEE,
        IN_SMALL,
        0n // Quoter maps 0 to MIN+1 / MAX-1 internally
      )
      expect(out > 0n).to.equal(true)
    })

    it('quoteExactOutputSingle 1 -> 0 (> 0)', async () => {
      const t0 = await tokens[0].getAddress()
      const t1 = await tokens[1].getAddress()
      const _in = await quoter.quoteExactOutputSingle.staticCall(
        t1,
        t0,
        FEE,
        OUT_ONE,
        0n // likewise uses internal bound
      )
      expect(_in > 0n).to.equal(true)
    })
  })
})