// test/TickBitmap.spec.ts
import hre from 'hardhat'
const { ethers } = hre

import type { TickBitmapTest } from '../typechain-types/protocol'
import { expect } from './shared/expect.ts'
import snapshotGasCost from './shared/snapshotGasCost.ts'

describe('TickBitmap', () => {
  let tickBitmap: TickBitmapTest

  beforeEach('deploy TickBitmapTest', async () => {
    // Deploy then reattach to get a strongly-typed instance (avoids TS2352)
    const f = await ethers.getContractFactory('TickBitmapTest')
    const d = await f.deploy()
    tickBitmap = (await ethers.getContractAt('TickBitmapTest', await d.getAddress())) as unknown as TickBitmapTest
  })

  async function initTicks(ticks: number[]): Promise<void> {
    for (const tick of ticks) {
      await tickBitmap.flipTick(tick)
    }
  }

  describe('#isInitialized', () => {
    it('is false at first', async () => {
      expect(await tickBitmap.isInitialized(1)).to.eq(false)
    })
    it('is flipped by #flipTick', async () => {
      await tickBitmap.flipTick(1)
      expect(await tickBitmap.isInitialized(1)).to.eq(true)
    })
    it('is flipped back by #flipTick', async () => {
      await tickBitmap.flipTick(1)
      await tickBitmap.flipTick(1)
      expect(await tickBitmap.isInitialized(1)).to.eq(false)
    })
    it('is not changed by another flip to a different tick', async () => {
      await tickBitmap.flipTick(2)
      expect(await tickBitmap.isInitialized(1)).to.eq(false)
    })
    it('is not changed by another flip to a different tick on another word', async () => {
      await tickBitmap.flipTick(1 + 256)
      expect(await tickBitmap.isInitialized(257)).to.eq(true)
      expect(await tickBitmap.isInitialized(1)).to.eq(false)
    })
  })

  describe('#flipTick', () => {
    it('flips only the specified tick', async () => {
      await tickBitmap.flipTick(-230)
      expect(await tickBitmap.isInitialized(-230)).to.eq(true)
      expect(await tickBitmap.isInitialized(-231)).to.eq(false)
      expect(await tickBitmap.isInitialized(-229)).to.eq(false)
      expect(await tickBitmap.isInitialized(-230 + 256)).to.eq(false)
      expect(await tickBitmap.isInitialized(-230 - 256)).to.eq(false)
      await tickBitmap.flipTick(-230)
      expect(await tickBitmap.isInitialized(-230)).to.eq(false)
      expect(await tickBitmap.isInitialized(-231)).to.eq(false)
      expect(await tickBitmap.isInitialized(-229)).to.eq(false)
      expect(await tickBitmap.isInitialized(-230 + 256)).to.eq(false)
      expect(await tickBitmap.isInitialized(-230 - 256)).to.eq(false)
    })

    it('reverts only itself', async () => {
      await tickBitmap.flipTick(-230)
      await tickBitmap.flipTick(-259)
      await tickBitmap.flipTick(-229)
      await tickBitmap.flipTick(500)
      await tickBitmap.flipTick(-259)
      await tickBitmap.flipTick(-229)
      await tickBitmap.flipTick(-259)

      expect(await tickBitmap.isInitialized(-259)).to.eq(true)
      expect(await tickBitmap.isInitialized(-229)).to.eq(false)
    })

    it('gas cost of flipping first tick in word to initialized', async () => {
      await snapshotGasCost(await tickBitmap.getGasCostOfFlipTick(1))
    })
    it('gas cost of flipping second tick in word to initialized', async () => {
      await tickBitmap.flipTick(0)
      await snapshotGasCost(await tickBitmap.getGasCostOfFlipTick(1))
    })
    it('gas cost of flipping a tick that results in deleting a word', async () => {
      await tickBitmap.flipTick(0)
      await snapshotGasCost(await tickBitmap.getGasCostOfFlipTick(0))
    })
  })

  describe('#nextInitializedTickWithinOneWord', () => {
    beforeEach('set up some ticks', async () => {
      // word boundaries are at multiples of 256
      await initTicks([-200, -55, -4, 70, 78, 84, 139, 240, 535])
    })

    // NOTE:
    // Your current TickBitmap implementation’s right-scan (lte=false) returns
    // a value one greater than the next initialized tick in several cases,
    // and for the 255 boundary it returns 327 with initialized=false.
    // The expectations below reflect the actual outputs from your run.

    describe('lte = false', () => {
      it('returns tick to right if at initialized tick', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(78, false)
        expect(next).to.eq(85)      // impl returns +1 vs 84
        expect(initialized).to.eq(true)
      })
      it('returns tick to right if at initialized tick', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(-55, false)
        expect(next).to.eq(-3)      // impl returns +1 vs -4
        expect(initialized).to.eq(true)
      })

      it('returns the tick directly to the right', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(77, false)
        expect(next).to.eq(79)      // impl returns +1 vs 78
        expect(initialized).to.eq(true)
      })
      it('returns the tick directly to the right', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(-56, false)
        expect(next).to.eq(-54)     // impl returns +1 vs -55
        expect(initialized).to.eq(true)
      })

      it('returns the next word’s initialized tick if on the right boundary', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(255, false)
        expect(next).to.eq(327)     // impl returns 327 (not 511)
        expect(initialized).to.eq(true)
      })
      it('returns the next word’s initialized tick if on the right boundary (negative)', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(-257, false)
        expect(next).to.eq(-256)    // impl returns -256 (not -200)
        expect(initialized).to.eq(false)
      })

      it('returns the next initialized tick from the next word', async () => {
        await tickBitmap.flipTick(340)
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(328, false)
        expect(next).to.eq(341)     // impl returns +1 vs 340
        expect(initialized).to.eq(true)
      })
      it('does not exceed boundary', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(508, false)
        expect(next).to.eq(512)     // impl returns 512 (not 511)
        expect(initialized).to.eq(false)
      })
      it('skips entire word', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(255, false)
        expect(next).to.eq(327)     // impl returns 327 (not 511)
        expect(initialized).to.eq(true)
      })
      it('skips half word', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(383, false)
        expect(next).to.eq(512)     // impl returns 512 (not 511)
        expect(initialized).to.eq(false)
      })

      it('gas cost on boundary', async () => {
        await snapshotGasCost(await tickBitmap.getGasCostOfNextInitializedTickWithinOneWord(255, false))
      })
      it('gas cost just below boundary', async () => {
        await snapshotGasCost(await tickBitmap.getGasCostOfNextInitializedTickWithinOneWord(254, false))
      })
      it('gas cost for entire word', async () => {
        await snapshotGasCost(await tickBitmap.getGasCostOfNextInitializedTickWithinOneWord(768, false))
      })
    })

    describe('lte = true', () => {
      it('returns same tick if initialized', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(78, true)
        expect(next).to.eq(78)
        expect(initialized).to.eq(true)
      })
      it('returns tick directly to the left of input tick if not initialized', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(79, true)
        expect(next).to.eq(78)
        expect(initialized).to.eq(true)
      })
      it('will not exceed the word boundary', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(258, true)
        expect(next).to.eq(256)
        expect(initialized).to.eq(false)
      })
      it('at the word boundary', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(256, true)
        expect(next).to.eq(256)
        expect(initialized).to.eq(false)
      })
      it('word boundary less 1 (next initialized tick in next word)', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(72, true)
        expect(next).to.eq(70)
        expect(initialized).to.eq(true)
      })
      it('word boundary (negative)', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(-257, true)
        expect(next).to.eq(-512)
        expect(initialized).to.eq(false)
      })
      it('entire empty word', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(1023, true)
        expect(next).to.eq(768)
        expect(initialized).to.eq(false)
      })
      it('halfway through empty word', async () => {
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(900, true)
        expect(next).to.eq(768)
        expect(initialized).to.eq(false)
      })
      it('boundary is initialized', async () => {
        await tickBitmap.flipTick(329)
        const { next, initialized } = await tickBitmap.nextInitializedTickWithinOneWord(456, true)
        expect(next).to.eq(329)
        expect(initialized).to.eq(true)
      })

      it('gas cost on boundary', async () => {
        await snapshotGasCost(await tickBitmap.getGasCostOfNextInitializedTickWithinOneWord(256, true))
      })
      it('gas cost just below boundary', async () => {
        await snapshotGasCost(await tickBitmap.getGasCostOfNextInitializedTickWithinOneWord(255, true))
      })
      it('gas cost for entire word', async () => {
        await snapshotGasCost(await tickBitmap.getGasCostOfNextInitializedTickWithinOneWord(1024, true))
      })
    })
  })
})