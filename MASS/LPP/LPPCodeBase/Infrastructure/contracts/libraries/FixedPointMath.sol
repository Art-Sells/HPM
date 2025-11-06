// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library FixedPointMath {
    uint256 internal constant Q96 = 2**96;

    function mulDiv(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return (a * b) / d;
    }
}
