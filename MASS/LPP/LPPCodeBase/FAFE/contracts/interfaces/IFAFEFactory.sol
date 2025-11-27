// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFAFEFactory {
    // Existing (kept)
    event PoolCreated(address indexed pool, address indexed asset, address indexed usdc);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event TokenAllowed(address indexed token, bool allowed);

    event PairCreated(address indexed token0, address indexed token1, address pair, uint);

    event PoolCreated(address indexed token0, address indexed token1, uint24 fee, int24 tickSpacing, address pool);

    function treasury() external view returns (address);

    // allow-list
    function setAllowedToken(address token, bool allowed) external;
    function isTokenAllowed(address token) external view returns (bool);

    function createPool(address asset, address usdc) external returns (address pool);
    function setPoolHook(address pool, address hook) external;

    function setTreasury(address newTreasury) external;

    function isPool(address pool) external view returns (bool);
    function getPools() external view returns (address[] memory);
}