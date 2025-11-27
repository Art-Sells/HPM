// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IFAFEFactory } from "./interfaces/IFAFEFactory.sol";
import { FAFEPool } from "./FAFEPool.sol";

contract FAFEFactory is IFAFEFactory {
    // Original interfaces/events
    address[] private _pools;
    mapping(address => bool) private _isPool;

    // token allow-list
    mapping(address => bool) private _allowedToken;

    address public override treasury;

    event PoolCreatedV3(address indexed token0, address indexed token1, uint24 fee, int24 tickSpacing, address pool);

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
        emit TokenAllowed(token, allowed);
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

        FAFEPool p = new FAFEPool(asset, usdc, treasury, address(this));
        pool = address(p);
        _pools.push(pool);
        _isPool[pool] = true;

        // Original event
        emit PoolCreated(pool, asset, usdc);

        // MEV-friendly mirrors
        address token0 = asset < usdc ? asset : usdc;
        address token1 = asset < usdc ? usdc : asset;

        emit PairCreated(token0, token1, pool, _pools.length); 
        emit PoolCreatedV3(token0, token1, uint24(0), int24(1), pool); 
    }

    function setPoolHook(address pool, address hook) external override onlyTreasury {
        require(_isPool[pool], "unknown pool");
        require(hook != address(0), "zero hook");
        FAFEPool(pool).setHook(hook);
    }

    function isPool(address pool) external view override returns (bool) { return _isPool[pool]; }
    function getPools() external view override returns (address[] memory) { return _pools; }
}