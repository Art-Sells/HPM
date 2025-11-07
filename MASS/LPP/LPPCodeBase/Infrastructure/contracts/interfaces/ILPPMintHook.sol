// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPMintHook {
    event MCVQualified(address indexed lp, address indexed pool, uint8 tier, uint256 shareBps);
    event MCVRebatePaid(address indexed to, address indexed pool, address indexed token, uint256 amount, uint8 tier);

    struct MintParams {
        address pool;
        address to;
        uint256 amountAssetDesired;
        uint256 amountUsdcDesired;
        bytes data;
    }

    function mintWithRebate(MintParams calldata params) external returns (uint256 liquidityOut);
}