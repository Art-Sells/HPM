// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.20;

interface ILPPPoolMintCallback {
    /// @notice Called to `msg.sender` after minting liquidity to a position from ILPPPool#mint.
    /// @param amount0Owed The amount of token0 due to the pool for the minted liquidity
    /// @param amount1Owed The amount of token1 due to the pool for the minted liquidity
    /// @param data Any data passed through by the caller via the ILPPPool#mint call
    function lppMintCallback(int256 amount0Owed, int256 amount1Owed, bytes calldata data) external;
}

interface ILPPPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function liquidity() external view returns (uint128);
    function mint(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        bytes calldata data
    ) external returns (uint256 amount0, uint256 amount1);
}
