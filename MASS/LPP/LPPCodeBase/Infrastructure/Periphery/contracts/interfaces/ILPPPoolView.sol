// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.7.6;

interface ILPPPoolView {
    function token0() external view returns (address);
    function token1() external view returns (address);

    // Common slot0 layout (name-only for compatibility)
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16,
            uint16,
            uint16,
            uint8,
            bool
        );

    // Current total liquidity in the pool
    function liquidity() external view returns (uint128);
}