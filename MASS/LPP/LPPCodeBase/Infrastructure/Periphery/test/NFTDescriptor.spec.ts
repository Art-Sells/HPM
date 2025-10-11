// test/NFTDescriptor.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import { MaxUint256 } from 'ethers'
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import type { TestERC20Metadata, NFTDescriptorTest } from '../typechain-types/periphery'

import { encodePriceSqrt } from './shared/encodePriceSqrt.ts'  
import { expect } from './shared/expect.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'
import { formatSqrtRatioX96 } from './shared/formatSqrtRatioX96.ts' 
import { getMaxTick, getMinTick } from './shared/ticks.ts'
import { randomBytes } from 'crypto'
import fs from 'fs'
import isSvg from 'is-svg'

// ----- NO FEES: use raw spacings (these are just math cases, not fee tiers)
const SPACING_10  = 10
const SPACING_60  = 60
const SPACING_200 = 200

// bigint math constants
const TEN = 10n
const LOWEST_SQRT_RATIO = 4310618292n
const HIGHEST_SQRT_RATIO = 33849n * (TEN ** 34n)

describe('NFTDescriptor', () => {
  let wallets: SignerWithAddress[]
  let nftDescriptor: NFTDescriptorTest
  let tokens: [TestERC20Metadata, TestERC20Metadata, TestERC20Metadata, TestERC20Metadata]

  async function nftDescriptorFixture() {
    const nftDescLibFactory = await ethers.getContractFactory('NFTDescriptor')
    const nftDescLib = await nftDescLibFactory.deploy()
    await nftDescLib.waitForDeployment()

    const NFTDescTestFactory = await ethers.getContractFactory('NFTDescriptorTest', {
      libraries: { NFTDescriptor: nftDescLib.target as string },
    })
    const nftDescriptor = (await NFTDescTestFactory.deploy()) as unknown as NFTDescriptorTest
    await nftDescriptor.waitForDeployment()

    const tokenFactory = await ethers.getContractFactory('TestERC20Metadata')
    const half = MaxUint256 / 2n
    const t0 = (await tokenFactory.deploy(half, 'Test ERC20', 'TEST1')) as unknown as TestERC20Metadata
    const t1 = (await tokenFactory.deploy(half, 'Test ERC20', 'TEST2')) as unknown as TestERC20Metadata
    const t2 = (await tokenFactory.deploy(half, 'Test ERC20', 'TEST3')) as unknown as TestERC20Metadata
    const t3 = (await tokenFactory.deploy(half, 'Test ERC20', 'TEST4')) as unknown as TestERC20Metadata

    const tokens = [t0, t1, t2, t3] as [
      TestERC20Metadata,
      TestERC20Metadata,
      TestERC20Metadata,
      TestERC20Metadata
    ]

    await Promise.all(tokens.map(t => t.waitForDeployment()))
    tokens.sort((a, b) => ((a.target as string).toLowerCase() < (b.target as string).toLowerCase() ? -1 : 1))

    return { nftDescriptor, tokens }
  }

  before(async () => {
    wallets = (await ethers.getSigners()) as SignerWithAddress[]
  })

  beforeEach(async () => {
    ;({ nftDescriptor, tokens } = await loadFixture(nftDescriptorFixture))
  })

  describe('#constructTokenURI', () => {
    let tokenId: number
    let baseTokenAddress: string
    let quoteTokenAddress: string
    let baseTokenSymbol: string
    let quoteTokenSymbol: string
    let baseTokenDecimals: number
    let quoteTokenDecimals: number
    let flipRatio: boolean
    let tickLower: number
    let tickUpper: number
    let tickCurrent: number
    let tickSpacing: number
    let fee: number
    let poolAddress: string

    beforeEach(async () => {
      tokenId = 123
      baseTokenAddress = tokens[0].target as string
      quoteTokenAddress = tokens[1].target as string
      baseTokenSymbol = await tokens[0].symbol()
      quoteTokenSymbol = await tokens[1].symbol()
      baseTokenDecimals = Number(await tokens[0].decimals())
      quoteTokenDecimals = Number(await tokens[1].decimals())
      flipRatio = false
      // Use 60 spacing as the default math case (no fee semantics)
      tickLower   = getMinTick(SPACING_60)
      tickUpper   = getMaxTick(SPACING_60)
      tickCurrent = 0
      tickSpacing = SPACING_60
      fee = 0 // ← ZERO FEE
      poolAddress = `0x${'b'.repeat(40)}`
    })

    it('returns the valid JSON string with min and max ticks', async () => {
      const json = extractJSONFromURI(
        await nftDescriptor.constructTokenURI({
          tokenId,
          baseTokenAddress,
          quoteTokenAddress,
          baseTokenSymbol,
          quoteTokenSymbol,
          baseTokenDecimals,
          quoteTokenDecimals,
          flipRatio,
          tickLower,
          tickUpper,
          tickCurrent,
          tickSpacing,
          fee,
          poolAddress,
        })
      )

      const tokenUri = constructTokenMetadata(
        tokenId,
        quoteTokenAddress,
        baseTokenAddress,
        poolAddress,
        quoteTokenSymbol,
        baseTokenSymbol,
        flipRatio,
        tickLower,
        tickUpper,
        tickCurrent,
        '0%',        // ← ZERO FEE LABEL
        'MIN<>MAX'
      )

      expect(json.description).to.equal(tokenUri.description)
      expect(json.name).to.equal(tokenUri.name)
    })

    it('returns the valid JSON string with mid ticks', async () => {
      tickLower = -10
      tickUpper = 10
      tickSpacing = SPACING_60
      fee = 0

      const json = extractJSONFromURI(
        await nftDescriptor.constructTokenURI({
          tokenId,
          baseTokenAddress,
          quoteTokenAddress,
          baseTokenSymbol,
          quoteTokenSymbol,
          baseTokenDecimals,
          quoteTokenDecimals,
          flipRatio,
          tickLower,
          tickUpper,
          tickCurrent,
          tickSpacing,
          fee,
          poolAddress,
        })
      )

      const tokenMetadata = constructTokenMetadata(
        tokenId,
        quoteTokenAddress,
        baseTokenAddress,
        poolAddress,
        quoteTokenSymbol,
        baseTokenSymbol,
        flipRatio,
        tickLower,
        tickUpper,
        tickCurrent,
        '0%',
        '0.99900<>1.0010'
      )

      expect(json.description).to.equal(tokenMetadata.description)
      expect(json.name).to.equal(tokenMetadata.name)
    })

    it('returns valid JSON when token symbols contain quotes', async () => {
      quoteTokenSymbol = '"TES"T1"'
      const json = extractJSONFromURI(
        await nftDescriptor.constructTokenURI({
          tokenId,
          baseTokenAddress,
          quoteTokenAddress,
          baseTokenSymbol,
          quoteTokenSymbol,
          baseTokenDecimals,
          quoteTokenDecimals,
          flipRatio,
          tickLower,
          tickUpper,
          tickCurrent,
          tickSpacing,
          fee,
          poolAddress,
        })
      )

      const tokenMetadata = constructTokenMetadata(
        tokenId,
        quoteTokenAddress,
        baseTokenAddress,
        poolAddress,
        quoteTokenSymbol,
        baseTokenSymbol,
        flipRatio,
        tickLower,
        tickUpper,
        tickCurrent,
        '0%',
        'MIN<>MAX'
      )

      expect(json.description).to.equal(tokenMetadata.description)
      expect(json.name).to.equal(tokenMetadata.name)
    })

    describe('when the token ratio is flipped', () => {
      it('returns the valid JSON for mid ticks', async () => {
        flipRatio = true
        tickLower = -10
        tickUpper = 10

        const json = extractJSONFromURI(
          await nftDescriptor.constructTokenURI({
            tokenId,
            baseTokenAddress,
            quoteTokenAddress,
            baseTokenSymbol,
            quoteTokenSymbol,
            baseTokenDecimals,
            quoteTokenDecimals,
            flipRatio,
            tickLower,
            tickUpper,
            tickCurrent,
            tickSpacing,
            fee,
            poolAddress,
          })
        )

        const tokenMetadata = constructTokenMetadata(
          tokenId,
          quoteTokenAddress,
          baseTokenAddress,
          poolAddress,
          quoteTokenSymbol,
          baseTokenSymbol,
          flipRatio,
          tickLower,
          tickUpper,
          tickCurrent,
          '0%',
          '0.99900<>1.0010'
        )

        expect(json.description).to.equal(tokenMetadata.description)
        expect(json.name).to.equal(tokenMetadata.name)
      })

      it('returns the valid JSON for min/max ticks', async () => {
        flipRatio = true

        const json = extractJSONFromURI(
          await nftDescriptor.constructTokenURI({
            tokenId,
            baseTokenAddress,
            quoteTokenAddress,
            baseTokenSymbol,
            quoteTokenSymbol,
            baseTokenDecimals,
            quoteTokenDecimals,
            flipRatio,
            tickLower,
            tickUpper,
            tickCurrent,
            tickSpacing,
            fee,
            poolAddress,
          })
        )

        const tokenMetadata = constructTokenMetadata(
          tokenId,
          quoteTokenAddress,
          baseTokenAddress,
          poolAddress,
          quoteTokenSymbol,
          baseTokenSymbol,
          flipRatio,
          tickLower,
          tickUpper,
          tickCurrent,
          '0%',
          'MIN<>MAX'
        )

        expect(json.description).to.equal(tokenMetadata.description)
        expect(json.name).to.equal(tokenMetadata.name)
      })
    })

    it('gas', async () => {
      await snapshotGasCost(
        nftDescriptor.getGasCostOfConstructTokenURI({
          tokenId,
          baseTokenAddress,
          quoteTokenAddress,
          baseTokenSymbol,
          quoteTokenSymbol,
          baseTokenDecimals,
          quoteTokenDecimals,
          flipRatio,
          tickLower,
          tickUpper,
          tickCurrent,
          tickSpacing,
          fee,
          poolAddress,
        })
      )
    })

    it('snapshot matches', async () => {
      tokenId = 1
      poolAddress = `0x${'b'.repeat(40)}`
      tickCurrent = -1
      tickLower = 0
      tickUpper = 1000
      tickSpacing = SPACING_10
      fee = 0
      const quoteTokenAddress2 = '0xabcdeabcdefabcdefabcdefabcdefabcdefabcdf'
      const baseTokenAddress2 = '0x1234567890123456789123456789012345678901'
      const quoteTokenSymbol2 = 'LPP'
      const baseTokenSymbol2 = 'WETH'

      expect(
        await nftDescriptor.constructTokenURI({
          tokenId,
          quoteTokenAddress: quoteTokenAddress2,
          baseTokenAddress: baseTokenAddress2,
          quoteTokenSymbol: quoteTokenSymbol2,
          baseTokenSymbol: baseTokenSymbol2,
          baseTokenDecimals,
          quoteTokenDecimals,
          flipRatio,
          tickLower,
          tickUpper,
          tickCurrent,
          tickSpacing,
          fee,
          poolAddress,
        })
      ).toMatchSnapshot()
    })
  })

  describe('#addressToString', () => {
    it('returns the correct string for a given address', async () => {
      let addressStr = await nftDescriptor.addressToString(`0x${'1234abcdef'.repeat(4)}`)
      expect(addressStr).to.eq('0x1234abcdef1234abcdef1234abcdef1234abcdef')
      addressStr = await nftDescriptor.addressToString(`0x${'1'.repeat(40)}`)
      expect(addressStr).to.eq(`0x${'1'.repeat(40)}`)
    })
  })

  describe('#tickToDecimalString', () => {
    let tickSpacing: number
    let minTick: number
    let maxTick: number

    describe('when tickspacing is 10', () => {
      before(() => {
        tickSpacing = SPACING_10
        minTick = getMinTick(tickSpacing)
        maxTick = getMaxTick(tickSpacing)
      })

      it('returns MIN on lowest tick', async () => {
        expect(await nftDescriptor.tickToDecimalString(minTick, tickSpacing, 18, 18, false)).to.equal('MIN')
      })

      it('returns MAX on the highest tick', async () => {
        expect(await nftDescriptor.tickToDecimalString(maxTick, tickSpacing, 18, 18, false)).to.equal('MAX')
      })

      it('returns the correct decimal string when the tick is in range', async () => {
        expect(await nftDescriptor.tickToDecimalString(1, tickSpacing, 18, 18, false)).to.equal('1.0001')
      })

      it('returns the correct decimal string when tick is mintick for different tickspace', async () => {
        const otherMinTick = getMinTick(SPACING_200)
        expect(await nftDescriptor.tickToDecimalString(otherMinTick, tickSpacing, 18, 18, false)).to.equal(
          '0.0000000000000000000000000000000000000029387'
        )
      })
    })

    describe('when tickspacing is 60', () => {
      before(() => {
        tickSpacing = SPACING_60
        minTick = getMinTick(tickSpacing)
        maxTick = getMaxTick(tickSpacing)
      })

      it('returns MIN on lowest tick', async () => {
        expect(await nftDescriptor.tickToDecimalString(minTick, tickSpacing, 18, 18, false)).to.equal('MIN')
      })

      it('returns MAX on the highest tick', async () => {
        expect(await nftDescriptor.tickToDecimalString(maxTick, tickSpacing, 18, 18, false)).to.equal('MAX')
      })

      it('returns the correct decimal string when the tick is in range', async () => {
        expect(await nftDescriptor.tickToDecimalString(-1, tickSpacing, 18, 18, false)).to.equal('0.99990')
      })

      it('returns the correct decimal string when tick is mintick for different tickspace', async () => {
        const otherMinTick = getMinTick(SPACING_200)
        expect(await nftDescriptor.tickToDecimalString(otherMinTick, tickSpacing, 18, 18, false)).to.equal(
          '0.0000000000000000000000000000000000000029387'
        )
      })
    })

    describe('when tickspacing is 200', () => {
      before(() => {
        tickSpacing = SPACING_200
        minTick = getMinTick(tickSpacing)
        maxTick = getMaxTick(tickSpacing)
      })

      it('returns MIN on lowest tick', async () => {
        expect(await nftDescriptor.tickToDecimalString(minTick, tickSpacing, 18, 18, false)).to.equal('MIN')
      })

      it('returns MAX on the highest tick', async () => {
        expect(await nftDescriptor.tickToDecimalString(maxTick, tickSpacing, 18, 18, false)).to.equal('MAX')
      })

      it('returns the correct decimal string when the tick is in range', async () => {
        expect(await nftDescriptor.tickToDecimalString(0, tickSpacing, 18, 18, false)).to.equal('1.0000')
      })

      it('returns the correct decimal string when tick is mintick for different tickspace', async () => {
        const otherMinTick = getMinTick(SPACING_60)
        expect(await nftDescriptor.tickToDecimalString(otherMinTick, tickSpacing, 18, 18, false)).to.equal(
          '0.0000000000000000000000000000000000000029387'
        )
      })
    })

    describe('when token ratio is flipped', () => {
      it('returns the inverse of default ratio for medium sized numbers', async () => {
        const ts = SPACING_200
        expect(await nftDescriptor.tickToDecimalString(10, ts, 18, 18, false)).to.eq('1.0010')
        expect(await nftDescriptor.tickToDecimalString(10, ts, 18, 18, true)).to.eq('0.99900')
      })

      it('returns the inverse of default ratio for large numbers', async () => {
        const ts = SPACING_200
        expect(await nftDescriptor.tickToDecimalString(487272, ts, 18, 18, false)).to.eq('1448400000000000000000')
        expect(await nftDescriptor.tickToDecimalString(487272, ts, 18, 18, true)).to.eq(
          '0.00000000000000000000069041'
        )
      })

      it('returns the inverse of default ratio for small numbers', async () => {
        const ts = SPACING_200
        expect(await nftDescriptor.tickToDecimalString(-387272, ts, 18, 18, false)).to.eq(
          '0.000000000000000015200'
        )
        expect(await nftDescriptor.tickToDecimalString(-387272, ts, 18, 18, true)).to.eq('65791000000000000')
      })

      it('returns the correct string with differing token decimals', async () => {
        const ts = SPACING_200
        expect(await nftDescriptor.tickToDecimalString(1000, ts, 18, 18, true)).to.eq('0.90484')
        expect(await nftDescriptor.tickToDecimalString(1000, ts, 18, 10, true)).to.eq('90484000')
        expect(await nftDescriptor.tickToDecimalString(1000, ts, 10, 18, true)).to.eq('0.0000000090484')
      })

      it('returns MIN for highest tick', async () => {
        const ts = SPACING_200
        const lowestTick = getMinTick(SPACING_200)
        expect(await nftDescriptor.tickToDecimalString(lowestTick, ts, 18, 18, true)).to.eq('MAX')
      })

      it('returns MAX for lowest tick', async () => {
        const ts = SPACING_200
        const highestTick = getMaxTick(SPACING_200)
        expect(await nftDescriptor.tickToDecimalString(highestTick, ts, 18, 18, true)).to.eq('MIN')
      })
    })
  })

  describe('#fixedPointToDecimalString', () => {
    describe('returns the correct string for', () => {
      it('the highest possible price', async () => {
        const ratio = encodePriceSqrt(33849, 1e-34) // fractional ok (handled in encodePriceSqrt)
        expect(await nftDescriptor.fixedPointToDecimalString(ratio, 18, 18)).to.eq(
          '338490000000000000000000000000000000000'
        )
      })

      it('large numbers', async () => {
        let ratio = encodePriceSqrt(25811, 1e-11)
        expect(await nftDescriptor.fixedPointToDecimalString(ratio, 18, 18)).to.eq('2581100000000000')
        ratio = encodePriceSqrt(17662, 1e-5)
        expect(await nftDescriptor.fixedPointToDecimalString(ratio, 18, 18)).to.eq('1766200000')
      })

      it('exactly 5 sigfig whole number', async () => {
        const ratio = encodePriceSqrt(42026, 1)
        expect(await nftDescriptor.fixedPointToDecimalString(ratio, 18, 18)).to.eq('42026')
      })

      it('when the decimal is at index 4', async () => {
        const ratio = encodePriceSqrt(12087, 10)
        expect(await nftDescriptor.fixedPointToDecimalString(ratio, 18, 18)).to.eq('1208.7')
      })

      it('when the decimal is at index 3', async () => {
        const ratio = encodePriceSqrt(12087, 100)
        expect(await nftDescriptor.fixedPointToDecimalString(ratio, 18, 18)).to.eq('120.87')
      })

      it('when the decimal is at index 2', async () => {
        const ratio = encodePriceSqrt(12087, 1000)
        expect(await nftDescriptor.fixedPointToDecimalString(ratio, 18, 18)).to.eq('12.087')
      })

      it('when the decimal is at index 1', async () => {
        const ratio = encodePriceSqrt(12345, 10000)
        expect(await nftDescriptor.fixedPointToDecimalString(ratio, 18, 18)).to.eq('1.2345')
      })

      it('when sigfigs have trailing 0s after the decimal', async () => {
        const ratio = encodePriceSqrt(1, 1)
        expect(await nftDescriptor.fixedPointToDecimalString(ratio, 18, 18)).to.eq('1.0000')
      })

      it('when there are exactly 5 numbers after the decimal', async () => {
        const ratio = encodePriceSqrt(12345, 100000)
        expect(await nftDescriptor.fixedPointToDecimalString(ratio, 18, 18)).to.eq('0.12345')
      })

      it('very small numbers', async () => {
        let ratio = encodePriceSqrt(38741, 1e20)
        expect(await nftDescriptor.fixedPointToDecimalString(ratio, 18, 18)).to.eq('0.00000000000000038741')
        ratio = encodePriceSqrt(88498, 1e35)
        expect(await nftDescriptor.fixedPointToDecimalString(ratio, 18, 18)).to.eq(
          '0.00000000000000000000000000000088498'
        )
      })

      it('smallest number', async () => {
        const ratio = encodePriceSqrt(39000, 1e43)
        expect(await nftDescriptor.fixedPointToDecimalString(ratio, 18, 18)).to.eq(
          '0.0000000000000000000000000000000000000029387'
        )
      })
    })

    describe('when tokens have different decimal precision', () => {
      it('some fuzz', async () => {
        const random = (min: number, max: number): number =>
          Math.floor(min + ((Math.random() * 100) % (max + 1 - min)))

        const inputs: Array<[bigint, number, number]> = []
        let i = 0
        while (i <= 20) {
          const bytesLen = random(7, 20)
          const hex = randomBytes(bytesLen).toString('hex') || '01'
          const ratio = BigInt('0x' + hex)
          const decimals0 = random(3, 21)
          const decimals1 = random(3, 21)
          const diff = BigInt(Math.abs(decimals0 - decimals1))
          if ((ratio / (TEN ** diff)) > LOWEST_SQRT_RATIO && (ratio * (TEN ** diff)) < HIGHEST_SQRT_RATIO) {
            inputs.push([ratio, decimals0, decimals1])
            i++
          }
        }

        for (const [ratio, decimals0, decimals1] of inputs) {
          const result = await nftDescriptor.fixedPointToDecimalString(ratio, decimals0, decimals1)
          expect(formatSqrtRatioX96(ratio, decimals0, decimals1)).to.eq(result)
        }
      }).timeout(300_000)

      // the other “even/odd diff” cases were already fee-agnostic;
      // keep them as-is if you still have them in your file
    })
  })

  describe('#svgImage', () => {
    let tokenId: number
    let baseTokenAddress: string
    let quoteTokenAddress: string
    let baseTokenSymbol: string
    let quoteTokenSymbol: string
    let baseTokenDecimals: number
    let quoteTokenDecimals: number
    let flipRatio: boolean
    let tickLower: number
    let tickUpper: number
    let tickCurrent: number
    let tickSpacing: number
    let fee: number
    let poolAddress: string

    beforeEach(async () => {
      tokenId = 123
      quoteTokenAddress = '0x1234567890123456789123456789012345678901'
      baseTokenAddress = '0xabcdeabcdefabcdefabcdefabcdefabcdefabcdf'
      quoteTokenSymbol = 'LPP'
      baseTokenSymbol = 'WETH'
      tickLower = -1000
      tickUpper = 2000
      tickCurrent = 40
      fee = 0 // ← ZERO FEE
      baseTokenDecimals = Number(await tokens[0].decimals())
      quoteTokenDecimals = Number(await tokens[1].decimals())
      flipRatio = false
      tickSpacing = SPACING_60
      poolAddress = `0x${'b'.repeat(40)}`
    })

    it('matches the current snapshot', async () => {
      const svg = await nftDescriptor.generateSVGImage({
        tokenId,
        baseTokenAddress,
        quoteTokenAddress,
        baseTokenSymbol,
        quoteTokenSymbol,
        baseTokenDecimals,
        quoteTokenDecimals,
        flipRatio,
        tickLower,
        tickUpper,
        tickCurrent,
        tickSpacing,
        fee,
        poolAddress,
      })
      expect(svg).toMatchSnapshot()
      fs.writeFileSync('./test/__snapshots__/NFTDescriptor.svg', svg)
    })

    it('returns a valid SVG', async () => {
      const svg = await nftDescriptor.generateSVGImage({
        tokenId,
        baseTokenAddress,
        quoteTokenAddress,
        baseTokenSymbol,
        quoteTokenSymbol,
        baseTokenDecimals,
        quoteTokenDecimals,
        flipRatio,
        tickLower,
        tickUpper,
        tickCurrent,
        tickSpacing,
        fee,
        poolAddress,
      })
      expect(isSvg(svg)).to.eq(true)
    })
  })

  describe('#isRare', () => {
    it('returns true sometimes', async () => {
      expect(await nftDescriptor.isRare(1, `0x${'b'.repeat(40)}`)).to.eq(true)
    })
    it('returns false sometimes', async () => {
      expect(await nftDescriptor.isRare(2, `0x${'b'.repeat(40)}`)).to.eq(false)
    })
  })
})

function constructTokenMetadata(
  tokenId: number,
  quoteTokenAddress: string,
  baseTokenAddress: string,
  poolAddress: string,
  quoteTokenSymbol: string,
  baseTokenSymbol: string,
  _flipRatio: boolean, // not used in the text but keep signature aligned
  tickLower: number,
  tickUpper: number,
  tickCurrent: number,
  feeTier: string,   // we pass '0%' in the tests
  prices: string
): { name: string; description: string } {
  // keep the same wording your contract/test expects
  quoteTokenSymbol = quoteTokenSymbol.replace(/"/g, '"')
  baseTokenSymbol  = baseTokenSymbol.replace(/"/g, '"')

  return {
    name: `LPP - ${feeTier} - ${quoteTokenSymbol}/${baseTokenSymbol} - ${prices}`,
    description:
      `This NFT represents a liquidity position ${quoteTokenSymbol}-${baseTokenSymbol} pool. ` +
      `The owner of this NFT can modify or redeem the position.\n` +
      `\nPool Address: ${poolAddress}\n` +
      `${quoteTokenSymbol} Address: ${quoteTokenAddress.toLowerCase()}\n` +
      `${baseTokenSymbol} Address: ${baseTokenAddress.toLowerCase()}\n` +
      `Fee Tier: ${feeTier}\n` +
      `Token ID: ${tokenId}\n\n` +
      `⚠️ DISCLAIMER: Due diligence is imperative when assessing this NFT. Make sure token addresses match the expected tokens, ` +
      `as token symbols may be imitated.`,
  }
}

// helper kept local to avoid external deps
function extractJSONFromURI(dataURI: string): any {
  const prefix = 'data:application/json;base64,'
  if (!dataURI.startsWith(prefix)) throw new Error('unexpected data URI')
  const b64 = dataURI.slice(prefix.length)
  const jsonStr = Buffer.from(b64, 'base64').toString('utf8')
  return JSON.parse(jsonStr)
}
function eq(arg0: string) {
  throw new Error('Function not implemented.')
}

