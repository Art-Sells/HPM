// test/SupplicateMath.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import type { SupplicateMathTest, SqrtPriceMathTest } from '../typechain-types/protocol'

import { expect } from './shared/expect.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'
import { encodePriceSqrt, expandTo18Decimals } from './shared/utilities.ts'

async function deploySupplicateMath(): Promise<SupplicateMathTest> {
  const f = await ethers.getContractFactory('SupplicateMathTest')
  const d = await f.deploy()
  return (await ethers.getContractAt('SupplicateMathTest', await d.getAddress())) as unknown as SupplicateMathTest
}
async function deploySqrtPriceMath(): Promise<SqrtPriceMathTest> {
  const f = await ethers.getContractFactory('SqrtPriceMathTest')
  const d = await f.deploy()
  return (await ethers.getContractAt('SqrtPriceMathTest', await d.getAddress())) as unknown as SqrtPriceMathTest
}

describe('SupplicateMath', () => {
  let supplicateMath: SupplicateMathTest
  let sqrtPriceMath: SqrtPriceMathTest

  before(async () => {
    supplicateMath = await deploySupplicateMath()
    sqrtPriceMath = await deploySqrtPriceMath()
  })

  describe('#computeSupplicateStep', () => {
    it('exact amount in that gets capped at price target in one for zero', async () => {
      const price = encodePriceSqrt(1, 1)
      const priceTarget = encodePriceSqrt(101, 100)
      const liquidity = expandTo18Decimals(2)
      const amountAbs = expandTo18Decimals(1)
      const fee = 600
      const zeroForOne = false

      const { amountIn, amountOut, sqrtQ, feeAmount } = await supplicateMath.computeSupplicateStep(
        price,
        priceTarget,
        liquidity,
        amountAbs,
        fee
      )

      expect(amountIn).to.eq('9975124224178055')
      expect(feeAmount).to.eq('5988667735148')
      expect(amountOut).to.eq('9925619580021728')

      expect((amountIn as unknown as bigint) + (feeAmount as unknown as bigint), 'entire amount is not used').to.lt(
        BigInt(amountAbs.toString())
      )

      const priceAfterWholeInputAmount = await sqrtPriceMath.getNextSqrtPriceFromInput(
        price,
        liquidity,
        amountAbs,
        zeroForOne
      )

      expect(sqrtQ, 'price is capped at price target').to.eq(priceTarget)
      expect(BigInt(sqrtQ.toString()), 'price is less than price after whole input amount').to.lt(
        BigInt(priceAfterWholeInputAmount.toString())
      )
    })

    it('exact amount out that gets capped at price target in one for zero', async () => {
      const price = encodePriceSqrt(1, 1)
      const priceTarget = encodePriceSqrt(101, 100)
      const liquidity = expandTo18Decimals(2)
      const amountAbs = expandTo18Decimals(1)
      const amount = '-' + amountAbs.toString()
      const fee = 600
      const zeroForOne = false

      const { amountIn, amountOut, sqrtQ, feeAmount } = await supplicateMath.computeSupplicateStep(
        price,
        priceTarget,
        liquidity,
        amount,
        fee
      )

      expect(amountIn).to.eq('9975124224178055')
      expect(feeAmount).to.eq('5988667735148')
      expect(amountOut).to.eq('9925619580021728')
      expect(BigInt(amountOut.toString())).to.lt(BigInt(amountAbs.toString()))

      const priceAfterWholeOutputAmount = await sqrtPriceMath.getNextSqrtPriceFromOutput(
        price,
        liquidity,
        amountAbs,
        zeroForOne
      )

      expect(sqrtQ, 'price is capped at price target').to.eq(priceTarget)
      expect(BigInt(sqrtQ.toString()), 'price is less than price after whole output amount').to.lt(
        BigInt(priceAfterWholeOutputAmount.toString())
      )
    })

    it('exact amount in that is fully spent in one for zero', async () => {
      const price = encodePriceSqrt(1, 1)
      const priceTarget = encodePriceSqrt(1000, 100)
      const liquidity = expandTo18Decimals(2)
      const amountAbs = expandTo18Decimals(1)
      const fee = 600
      const zeroForOne = false

      const { amountIn, amountOut, sqrtQ, feeAmount } = await supplicateMath.computeSupplicateStep(
        price,
        priceTarget,
        liquidity,
        amountAbs,
        fee
      )

      expect(amountIn).to.eq('999400000000000000')
      expect(feeAmount).to.eq('600000000000000')
      expect(amountOut).to.eq('666399946655997866')
      expect((amountIn as unknown as bigint) + (feeAmount as unknown as bigint)).to.eq(BigInt(amountAbs.toString()))

      const amountLessFee = (BigInt(amountAbs.toString()) - (feeAmount as unknown as bigint)).toString()

      const priceAfterWholeInputAmountLessFee = await sqrtPriceMath.getNextSqrtPriceFromInput(
        price,
        liquidity,
        amountLessFee,
        zeroForOne
      )

      expect(BigInt(sqrtQ.toString())).to.lt(BigInt(priceTarget.toString()))
      expect(sqrtQ).to.eq(priceAfterWholeInputAmountLessFee)
    })

    it('exact amount out that is fully received in one for zero', async () => {
      const price = encodePriceSqrt(1, 1)
      const priceTarget = encodePriceSqrt(10000, 100)
      const liquidity = expandTo18Decimals(2)
      const amountAbs = expandTo18Decimals(1)
      const amount = '-' + amountAbs.toString()
      const fee = 600
      const zeroForOne = false

      const { amountIn, amountOut, sqrtQ, feeAmount } = await supplicateMath.computeSupplicateStep(
        price,
        priceTarget,
        liquidity,
        amount,
        fee
      )

      expect(amountIn).to.eq('2000000000000000000')
      expect(feeAmount).to.eq('1200720432259356')
      expect(amountOut).to.eq(amountAbs.toString())

      const priceAfterWholeOutputAmount = await sqrtPriceMath.getNextSqrtPriceFromOutput(
        price,
        liquidity,
        amountAbs,
        zeroForOne
      )

      expect(BigInt(sqrtQ.toString())).to.lt(BigInt(priceTarget.toString()))
      expect(sqrtQ).to.eq(priceAfterWholeOutputAmount)
    })

    it('amount out is capped at the desired amount out', async () => {
      const { amountIn, amountOut, sqrtQ, feeAmount } = await supplicateMath.computeSupplicateStep(
        '417332158212080721273783715441582',
        '1452870262520218020823638996',
        '159344665391607089467575320103',
        '-1',
        1
      )
      expect(amountIn).to.eq('1')
      expect(feeAmount).to.eq('1')
      expect(amountOut).to.eq('1')
      expect(sqrtQ).to.eq('417332158212080721273783715441581')
    })

    it('target price of 1 uses partial input amount', async () => {
      const { amountIn, amountOut, sqrtQ, feeAmount } = await supplicateMath.computeSupplicateStep(
        '2',
        '1',
        '1',
        '3915081100057732413702495386755767',
        1
      )
      expect(amountIn).to.eq('39614081257132168796771975168')
      expect(feeAmount).to.eq('39614120871253040049813')
      expect(
        (amountIn as unknown as bigint) + (feeAmount as unknown as bigint)
      ).to.be.lte(BigInt('3915081100057732413702495386755767'))
      expect(amountOut).to.eq('0')
      expect(sqrtQ).to.eq('1')
    })

    it('entire input amount taken as fee', async () => {
      const { amountIn, amountOut, sqrtQ, feeAmount } = await supplicateMath.computeSupplicateStep(
        '2413',
        '79887613182836312',
        '1985041575832132834610021537970',
        '10',
        1872
      )
      expect(amountIn).to.eq('0')
      expect(feeAmount).to.eq('10')
      expect(amountOut).to.eq('0')
      expect(sqrtQ).to.eq('2413')
    })

    it('handles intermediate insufficient liquidity in zero for one exact output case', async () => {
      const sqrtP = BigInt('20282409603651670423947251286016')
      const sqrtPTarget = ((sqrtP * 11n) / 10n).toString()
      const liquidity = 1024
      const amountRemaining = -4
      const feePips = 3000
      const { amountIn, amountOut, sqrtQ, feeAmount } = await supplicateMath.computeSupplicateStep(
        sqrtP.toString(),
        sqrtPTarget,
        liquidity,
        amountRemaining,
        feePips
      )
      expect(amountOut).to.eq('0')
      expect(sqrtQ).to.eq(sqrtPTarget)
      expect(amountIn).to.eq('26215')
      expect(feeAmount).to.eq('79')
    })

    it('handles intermediate insufficient liquidity in one for zero exact output case', async () => {
      const sqrtP = BigInt('20282409603651670423947251286016')
      const sqrtPTarget = ((sqrtP * 9n) / 10n).toString()
      const liquidity = 1024
      const amountRemaining = -263000
      const feePips = 3000
      const { amountIn, amountOut, sqrtQ, feeAmount } = await supplicateMath.computeSupplicateStep(
        sqrtP.toString(),
        sqrtPTarget,
        liquidity,
        amountRemaining,
        feePips
      )
      expect(amountOut).to.eq('26214')
      expect(sqrtQ).to.eq(sqrtPTarget)
      expect(amountIn).to.eq('1')
      expect(feeAmount).to.eq('1')
    })

    describe('gas', () => {
      it('supplicate one for zero exact in capped', async () => {
        await snapshotGasCost(
          supplicateMath.getGasCostOfComputeSupplicateStep(
            encodePriceSqrt(1, 1),
            encodePriceSqrt(101, 100),
            expandTo18Decimals(2),
            expandTo18Decimals(1),
            600
          )
        )
      })
      it('supplicate zero for one exact in capped', async () => {
        await snapshotGasCost(
          supplicateMath.getGasCostOfComputeSupplicateStep(
            encodePriceSqrt(1, 1),
            encodePriceSqrt(99, 100),
            expandTo18Decimals(2),
            expandTo18Decimals(1),
            600
          )
        )
      })
      it('supplicate one for zero exact out capped', async () => {
        await snapshotGasCost(
          supplicateMath.getGasCostOfComputeSupplicateStep(
            encodePriceSqrt(1, 1),
            encodePriceSqrt(101, 100),
            expandTo18Decimals(2),
            '-' + expandTo18Decimals(1).toString(),
            600
          )
        )
      })
      it('supplicate zero for one exact out capped', async () => {
        await snapshotGasCost(
          supplicateMath.getGasCostOfComputeSupplicateStep(
            encodePriceSqrt(1, 1),
            encodePriceSqrt(99, 100),
            expandTo18Decimals(2),
            '-' + expandTo18Decimals(1).toString(),
            600
          )
        )
      })
      it('supplicate one for zero exact in partial', async () => {
        await snapshotGasCost(
          supplicateMath.getGasCostOfComputeSupplicateStep(
            encodePriceSqrt(1, 1),
            encodePriceSqrt(1010, 100),
            expandTo18Decimals(2),
            1000,
            600
          )
        )
      })
      it('supplicate zero for one exact in partial', async () => {
        await snapshotGasCost(
          supplicateMath.getGasCostOfComputeSupplicateStep(
            encodePriceSqrt(1, 1),
            encodePriceSqrt(99, 1000),
            expandTo18Decimals(2),
            1000,
            600
          )
        )
      })
      it('supplicate one for zero exact out partial', async () => {
        await snapshotGasCost(
          supplicateMath.getGasCostOfComputeSupplicateStep(
            encodePriceSqrt(1, 1),
            encodePriceSqrt(1010, 100),
            expandTo18Decimals(2),
            1000,
            600
          )
        )
      })
      it('supplicate zero for one exact out partial', async () => {
        await snapshotGasCost(
          supplicateMath.getGasCostOfComputeSupplicateStep(
            encodePriceSqrt(1, 1),
            encodePriceSqrt(99, 1000),
            expandTo18Decimals(2),
            1000,
            600
          )
        )
      })
    })
  })
})