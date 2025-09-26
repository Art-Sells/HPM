// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import "./BitMath.sol";

library TickBitmap {
    function position(int24 tick, int24 tickSpacing)
        internal
        pure
        returns (int16 wordPos, uint8 bitPos, int24 compressed)
    {
        compressed = tick / tickSpacing;
        wordPos = int16(compressed >> 8);
        bitPos = uint8(uint256(int256(compressed)) % 256);
    }

    function flipTick(
        mapping(int16 => uint256) storage self,
        int24 tick,
        int24 tickSpacing
    ) internal {
        (int16 wordPos, uint8 bitPos, ) = position(tick, tickSpacing);
        self[wordPos] ^= (uint256(1) << bitPos);
    }

    function nextInitializedTickWithinOneWord(
        mapping(int16 => uint256) storage self,
        int24 tick,
        int24 tickSpacing,
        bool lte
    ) internal view returns (int24 next, bool initialized) {
        (int16 wordPos, uint8 bitPos, int24 compressed) = position(tick, tickSpacing);
        uint256 word = self[wordPos];

        if (lte) {
            uint256 mask = ((uint256(1) << bitPos) - 1) | (uint256(1) << bitPos);
            uint256 masked = word & mask;
            initialized = masked != 0;
            if (initialized) {
                uint8 msb = BitMath.mostSignificantBit(masked);
                next = (compressed - int24(uint24(bitPos - msb))) * tickSpacing;
            } else {
                next = (compressed - int24(uint24(bitPos))) * tickSpacing;
            }
        } else {
            uint256 mask = ~((uint256(1) << (bitPos + 1)) - 1);
            uint256 masked = word & mask;
            initialized = masked != 0;
            if (initialized) {
                uint8 lsb = BitMath.leastSignificantBit(masked);
                next = (compressed + 1 + int24(uint24(lsb - bitPos))) * tickSpacing;
            } else {
                next = (compressed + 1 + int24(uint24(255 - bitPos))) * tickSpacing;
            }
        }
    }
}