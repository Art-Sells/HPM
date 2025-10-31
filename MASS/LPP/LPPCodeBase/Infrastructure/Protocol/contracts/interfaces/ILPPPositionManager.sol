// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.20;

interface ILPPPositionManager {
    /// Called by the mint hook AFTER rebate/retention is settled to finalize the NFT position
    function finalizeMintFromHook(
        address pool,
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint8 tier,
        uint32 hookSuggestedLockSecs
    ) external returns (uint256 tokenId);
}