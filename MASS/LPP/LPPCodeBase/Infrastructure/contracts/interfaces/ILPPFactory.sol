// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPFactory {
    event PoolCreated(address indexed pool, address indexed asset, address indexed usdc);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);

    function treasury() external view returns (address);

    function createPool(address asset, address usdc) external returns (address pool);
    function setPoolHook(address pool, address hook) external;

    function setTreasury(address newTreasury) external;

    function isPool(address pool) external view returns (bool);
    function getPools() external view returns (address[] memory);
}