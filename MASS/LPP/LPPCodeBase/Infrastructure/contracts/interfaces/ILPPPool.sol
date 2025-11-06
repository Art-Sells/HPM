// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPPool {
    event Mint(address indexed lp, uint256 amountAsset, uint256 amountUsdc, uint256 liquidity);
    event Burn(address indexed lp, uint256 liquidity, uint256 amountAssetOut, uint256 amountUsdcOut);
    event Supplicate(address indexed caller, bool assetToUsdc, uint256 amountIn, uint256 amountOut);

    function asset() external view returns (address);
    function usdc() external view returns (address);

    // simplified reserves for asset/usdc
    function reserveAsset() external view returns (uint256);
    function reserveUsdc() external view returns (uint256);

    // Liquidity operations
    function quoteMint(uint256 amountAssetDesired, uint256 amountUsdcDesired) external view returns (uint256 liquidityOut);
    function mint(address to, uint256 amountAssetDesired, uint256 amountUsdcDesired) external returns (uint256 liquidityOut);

    function burn(address to, uint256 liquidity) external returns (uint256 amountAssetOut, uint256 amountUsdcOut);

    // Supplication (rebalance trade)
    function quoteSupplication(bool assetToUsdc, uint256 amountIn) external view returns (uint256 amountOut, int256 priceDriftBps);
    function supplicate(address to, bool assetToUsdc, uint256 amountIn, uint256 minAmountOut) external returns (uint256 amountOut);

    // Price telemetry (placeholder)
    function priceX96() external view returns (uint256);
}
