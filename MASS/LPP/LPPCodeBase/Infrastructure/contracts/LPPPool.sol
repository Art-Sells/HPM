// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPPool } from "./interfaces/ILPPPool.sol";

contract LPPPool is ILPPPool {
    address public immutable override asset;
    address public immutable override usdc;

    uint256 public override reserveAsset;
    uint256 public override reserveUsdc;

    uint256 private _priceX96; // placeholder

    mapping(address => uint256) private _liq;
    uint256 public totalLiquidity;

    modifier nonZero(uint256 x) { require(x > 0, "zero"); _; }

    constructor(address _asset, address _usdc) {
        require(_asset != address(0) && _usdc != address(0), "zero token");
        asset = _asset;
        usdc = _usdc;
        _priceX96 = 1 << 96;
    }

    function priceX96() external view override returns (uint256) { return _priceX96; }

    function liquidityOf(address who) external view override returns (uint256) {
        return _liq[who];
    }

    function quoteMint(uint256 amountAssetDesired, uint256 amountUsdcDesired) external pure override returns (uint256 liquidityOut) {
        liquidityOut = amountAssetDesired + amountUsdcDesired;
    }

    function mint(address to, uint256 amountAssetDesired, uint256 amountUsdcDesired) external override nonZero(amountAssetDesired) nonZero(amountUsdcDesired) returns (uint256 liquidityOut) {
        liquidityOut = amountAssetDesired + amountUsdcDesired;
        reserveAsset += amountAssetDesired;
        reserveUsdc += amountUsdcDesired;
        totalLiquidity += liquidityOut;
        _liq[to] += liquidityOut;
        emit Mint(to, amountAssetDesired, amountUsdcDesired, liquidityOut);
    }

    function burn(address to, uint256 liquidity) external override nonZero(liquidity) returns (uint256 amountAssetOut, uint256 amountUsdcOut) {
        require(_liq[msg.sender] >= liquidity, "insufficient liq");
        _liq[msg.sender] -= liquidity;
        totalLiquidity -= liquidity;

        amountAssetOut = (reserveAsset * liquidity) / (liquidity + totalLiquidity);
        amountUsdcOut  = (reserveUsdc  * liquidity) / (liquidity + totalLiquidity);

        reserveAsset -= amountAssetOut;
        reserveUsdc  -= amountUsdcOut;

        emit Burn(to, liquidity, amountAssetOut, amountUsdcOut);
    }

    function quoteSupplication(bool assetToUsdc, uint256 amountIn) external view override returns (uint256 amountOut, int256 priceDriftBps) {
        require(reserveUsdc > 0 && reserveAsset > 0, "empty reserves");
        if (assetToUsdc) {
            amountOut = (amountIn * reserveUsdc) / (reserveAsset + amountIn);
            priceDriftBps = int256( (amountIn * 10_000) / (reserveAsset + 1) );
        } else {
            amountOut = (amountIn * reserveAsset) / (reserveUsdc + amountIn);
            priceDriftBps = int256( (amountIn * 10_000) / (reserveUsdc + 1) );
        }
    }

    function supplicate(address /*to*/, bool assetToUsdc, uint256 amountIn, uint256 minAmountOut) external override nonZero(amountIn) returns (uint256 amountOut) {
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
}
