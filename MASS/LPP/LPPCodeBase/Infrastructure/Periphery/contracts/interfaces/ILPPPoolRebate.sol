// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.7.6;

interface ILPPPoolRebate {
    // Preferred signature (explicit payer provided to pool/hook callback context)
    function mintWithRebate(
        address owner,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        address payer,
        bytes calldata data
    ) external returns (uint256 amount0, uint256 amount1);

    // Optional legacy signature (no explicit payer)
    function mintWithRebate(
        address owner,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        bytes calldata data
    ) external returns (uint256 amount0, uint256 amount1);
}