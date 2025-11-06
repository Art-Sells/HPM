// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPFactory } from "./interfaces/ILPPFactory.sol";
import { LPPPool } from "./LPPPool.sol";

contract LPPFactory is ILPPFactory {
    address[] private _pools;
    mapping(address => bool) private _isPool;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    address public owner;

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

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
        LPPPool p = new LPPPool(asset, usdc);
        pool = address(p);
        _pools.push(pool);
        _isPool[pool] = true;
        emit PoolCreated(pool, asset, usdc);
    }

    function isPool(address pool) external view returns (bool) { return _isPool[pool]; }
    function getPools() external view returns (address[] memory) { return _pools; }
}
