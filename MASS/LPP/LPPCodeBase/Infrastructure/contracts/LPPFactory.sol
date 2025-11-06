// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPFactory } from "./interfaces/ILPPFactory.sol";

contract LPPFactory is ILPPFactory {
    address[] private _pools;
    mapping(address => bool) private _isPool;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function createPool(address asset, address usdc) external onlyOwner returns (address pool) {
        require(asset != address(0) && usdc != address(0), "zero token");
        // NOTE: In a real implementation we'd deploy a minimal proxy / clone with init.
        // For scaffold, just emit and track. Replace with real deployment later.
        pool = address(uint160(uint256(keccak256(abi.encode(block.timestamp, asset, usdc, _pools.length)))));
        _pools.push(pool);
        _isPool[pool] = true;
        emit PoolCreated(pool, asset, usdc);
    }

    function isPool(address pool) external view returns (bool) { return _isPool[pool]; }
    function getPools() external view returns (address[] memory) { return _pools; }
}
