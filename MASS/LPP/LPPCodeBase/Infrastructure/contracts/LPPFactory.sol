// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPFactory } from "./interfaces/ILPPFactory.sol";
import { LPPPool } from "./LPPPool.sol";

contract LPPFactory is ILPPFactory {
    address[] private _pools;
    mapping(address => bool) private _isPool;

    // token allow-list
    mapping(address => bool) private _allowedToken;

    address public override treasury;

    modifier onlyTreasury() { require(msg.sender == treasury, "only treasury"); _; }

    constructor(address _treasury) {
        require(_treasury != address(0), "zero treasury");
        treasury = _treasury;
        emit TreasuryUpdated(address(0), _treasury);
    }

    function setTreasury(address newTreasury) external onlyTreasury {
        require(newTreasury != address(0), "zero treasury");
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    // ── allow-list control ──────────────────────────────────────────────
    function setAllowedToken(address token, bool allowed) external override onlyTreasury {
        require(token != address(0), "zero token");
        _allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed); // ✅ correct event name
    }

    function isTokenAllowed(address token) external view override returns (bool) {
        return _allowedToken[token];
    }

    // ── pool lifecycle ─────────────────────────────────────────────────
    function createPool(address asset, address usdc)
        external
        override
        onlyTreasury
        returns (address pool)
    {
        require(asset != address(0) && usdc != address(0), "zero token");
        require(_allowedToken[asset] && _allowedToken[usdc], "token not allowed");

        LPPPool p = new LPPPool(asset, usdc, treasury, address(this));
        pool = address(p);
        _pools.push(pool);
        _isPool[pool] = true;
        emit PoolCreated(pool, asset, usdc);
    }

    function setPoolHook(address pool, address hook) external override onlyTreasury {
        require(_isPool[pool], "unknown pool");
        require(hook != address(0), "zero hook");
        LPPPool(pool).setHook(hook);
    }

    function isPool(address pool) external view override returns (bool) { return _isPool[pool]; }
    function getPools() external view override returns (address[] memory) { return _pools; }
}