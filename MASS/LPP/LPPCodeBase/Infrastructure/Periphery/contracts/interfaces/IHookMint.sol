// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.7.6;
pragma abicoder v2;

interface IHookMint {
    /// @notice Params for a fresh mint executed via the pool’s configured hook.
    /// @dev Manager provides desired token amounts; hook computes liquidity from current price.
    struct MintViaHookParams {
        address pool;            // pool address
        address recipient;       // who receives the position/NFT (manager will mint to this)
        address payer;           // who funds owed tokens during callback (approved hook)
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;  // desired token0 to spend
        uint256 amount1Desired;  // desired token1 to spend
    }

    /// @notice Params for increasing liquidity on an existing position via the hook.
    struct IncreaseViaHookParams {
        address pool;
        uint256 tokenId;         // position tokenId being increased
        address payer;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
    }

    /// @notice Called by the manager; hook must run the rebate path and then call manager.finalizeMintFromHook.
    function mintViaHook(MintViaHookParams calldata p) external;

    /// @notice Called by the manager; hook must run the rebate path and then call manager.finalizeIncreaseFromHook.
    function increaseViaHook(IncreaseViaHookParams calldata p) external;
}