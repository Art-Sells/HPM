// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.7.6;
pragma abicoder v2;

interface IHookMint {
    struct MintViaHookParams {
        address pool;
        address recipient;    // who receives the position/NFT
        address payer;        // who funds owed tokens during callback
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
    }

    struct IncreaseViaHookParams {
        address pool;
        uint256 tokenId;      // position being increased
        address payer;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        // Or: uint128 liquidity;
    }

    function mintViaHook(MintViaHookParams calldata p) external;
    function increaseViaHook(IncreaseViaHookParams calldata p) external;
}