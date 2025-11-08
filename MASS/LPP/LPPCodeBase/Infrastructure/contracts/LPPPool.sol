// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPPool } from "./interfaces/ILPPPool.sol";

contract LPPPool is ILPPPool {
    address public /*override*/ immutable asset;
    address public /*override*/ immutable usdc;

    address public /*override*/ immutable treasury; // project-level authority
    address public /*override*/ immutable factory;  // deploying factory (authorized to set hook)
    address public /*override*/ hook;               // LPPMintHook set exactly once

    uint256 public /*override*/ reserveAsset;
    uint256 public /*override*/ reserveUsdc;

    uint256 private _priceX96;
    mapping(address => uint256) private _liq;
    uint256 public /*override*/ totalLiquidity;

    bool public initialized;

    modifier nonZero(uint256 x) { require(x > 0, "zero"); _; }
    modifier onlyHook() { require(msg.sender == hook, "only hook"); _; }
    modifier onlyTreasuryOrFactory() { require(msg.sender == treasury || msg.sender == factory, "only auth"); _; }

    constructor(address _asset, address _usdc, address _treasury, address _factory) {
        require(_asset != address(0) && _usdc != address(0) && _treasury != address(0) && _factory != address(0), "zero");
        asset = _asset;
        usdc = _usdc;
        treasury = _treasury;
        factory  = _factory;
        _priceX96 = 1 << 96;
    }

    function priceX96() external view override returns (uint256) { return _priceX96; }
    function liquidityOf(address who) external view override returns (uint256) { return _liq[who]; }

    function setHook(address hook_) external override onlyTreasuryOrFactory {
        require(hook == address(0), "hook set");
        require(hook_ != address(0), "zero hook");
        hook = hook_;
        emit HookSet(hook_);
    }

    function bootstrapInitialize(uint256 amtA, uint256 amtU)
        external
        onlyHook
        nonZero(amtA)
        nonZero(amtU)
    {
        require(!initialized, "already init");
        _internalMint(treasury, amtA, amtU);
        initialized = true;
        emit Initialized(amtA, amtU);
    }

    function mintFromHook(address to, uint256 amtA, uint256 amtU)
        external
        override
        onlyHook
        nonZero(amtA)
        nonZero(amtU)
        returns (uint256 liquidityOut)
    {
        liquidityOut = _internalMint(to, amtA, amtU);
    }

    function _internalMint(address to, uint256 amountAssetDesired, uint256 amountUsdcDesired)
        internal
        returns (uint256 liquidityOut)
    {
        liquidityOut = amountAssetDesired + amountUsdcDesired;
        reserveAsset += amountAssetDesired;
        reserveUsdc  += amountUsdcDesired;
        totalLiquidity += liquidityOut;
        _liq[to] += liquidityOut;
        emit Mint(to, amountAssetDesired, amountUsdcDesired, liquidityOut);
    }

    function burn(address to, uint256 liquidity)
        external
        override
        nonZero(liquidity)
        returns (uint256 amountAssetOut, uint256 amountUsdcOut)
    {
        uint256 bal = _liq[msg.sender];
        require(bal >= liquidity, "insufficient liq");
        _liq[msg.sender] = bal - liquidity;

        uint256 totalAfter = totalLiquidity - liquidity;
        uint256 denom = liquidity + totalAfter;

        amountAssetOut = (reserveAsset * liquidity) / denom;
        amountUsdcOut  = (reserveUsdc  * liquidity) / denom;

        reserveAsset -= amountAssetOut;
        reserveUsdc  -= amountUsdcOut;
        totalLiquidity = totalAfter;

        emit Burn(to, liquidity, amountAssetOut, amountUsdcOut);
    }

    function quoteSupplication(bool assetToUsdc, uint256 amountIn)
        external
        view
        override
        returns (uint256 amountOut, int256 priceDriftBps)
    {
        require(reserveUsdc > 0 && reserveAsset > 0, "empty reserves");
        if (assetToUsdc) {
            amountOut = (amountIn * reserveUsdc) / (reserveAsset + amountIn);
            priceDriftBps = int256((amountIn * 10_000) / (reserveAsset + 1));
        } else {
            amountOut = (amountIn * reserveAsset) / (reserveUsdc + amountIn);
            priceDriftBps = int256((amountIn * 10_000) / (reserveUsdc + 1));
        }
    }

    function supplicate(address /*to*/, bool assetToUsdc, uint256 amountIn, uint256 minAmountOut)
        external
        override
        nonZero(amountIn)
        returns (uint256 amountOut)
    {
        (amountOut, ) = this.quoteSupplication(assetToUsdc, amountIn);
        require(amountOut >= minAmountOut, "slippage");

        if (assetToUsdc) {
            reserveAsset += amountIn;
            require(reserveUsdc >= amountOut, "insufficient usdc");
            reserveUsdc -= amountOut;
        } else {
            reserveUsdc += amountIn;
            require(reserveAsset >= amountOut, "insufficient asset");
            reserveAsset -= amountOut;
        }

        emit Supplicate(msg.sender, assetToUsdc, amountIn, amountOut);
    }
    // add: set price on first bootstrap
function bootstrapInitialize(uint256 amtA, uint256 amtU, int256 offsetBps)
    external
    onlyHook
    nonZero(amtA)
    nonZero(amtU)
{
    require(!initialized, "already init");
    _internalMint(treasury, amtA, amtU);

    // base price = usdc/asset in Q96
    uint256 baseX96 = (amtU << 96) / amtA;

    if (offsetBps != 0) {
        // priceX96 = baseX96 * (10000 + offsetBps) / 10000 ; supports negative offsets
        int256 num = int256(uint256(baseX96)) * (10000 + offsetBps);
        require(num > 0, "bad offset");
        _priceX96 = uint256(num) / 10000;
    } else {
        _priceX96 = baseX96;
    }

    initialized = true;
    emit Initialized(amtA, amtU);
}
}