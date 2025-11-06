// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPFactory {
    event PoolCreated(address indexed pool, address indexed asset, address indexed usdc);
    function createPool(address asset, address usdc) external returns (address pool);
    function isPool(address pool) external view returns (bool);
    function getPools() external view returns (address[] memory);
}
