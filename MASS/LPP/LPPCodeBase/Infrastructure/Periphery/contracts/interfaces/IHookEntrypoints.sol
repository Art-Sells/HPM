// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

interface IHookEntrypoints {
    /// Called by the pool's configured hook during the pool's mint callback.
    /// The manager pays the pool (wraps ETH to WETH as needed).
    function hookPay(address pool, address token, uint256 amount) external;

    /// Called by the hook after pool.mint() finishes to finalize a new position NFT.
    function finalizeMintFromHook(
        address pool,
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    ) external returns (uint256 tokenId);

    /// Called by the hook after pool.mint() that adds liquidity to an existing position.
    function finalizeIncreaseFromHook(
        address pool,
        uint256 tokenId,
        int24 tickLower,
        int24 tickUpper,
        uint128 addedLiquidity,
        uint256 amount0,
        uint256 amount1
    ) external;
}