// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

/// @notice Minimal interface for a pair/LP token,
/// replicated locally under LPP naming so Migrator can compile.
interface ILPPV2Pair {
    // ERC20 bits on the LP token contract
    function balanceOf(address owner) external view returns (uint256);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);

    // EIP-2612 permit often used by the migrator (gas-less approve)
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external;

    // Pair metadata
    function token0() external view returns (address);
    function token1() external view returns (address);

    // Remove liquidity after LP tokens are sent to the pair
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
}
