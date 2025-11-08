// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPPool {
    // Events (declare them here once; do NOT redeclare in the contract)
    event HookSet(address hook);
    event Initialized(uint256 amountAsset, uint256 amountUsdc);
    event Mint(address indexed lp, uint256 amountAsset, uint256 amountUsdc, uint256 liquidity);
    event Burn(address indexed lp, uint256 liquidity, uint256 amountAssetOut, uint256 amountUsdcOut);
    event Supplicate(address indexed caller, bool assetToUsdc, uint256 amountIn, uint256 amountOut);

    // Token getters
    function asset() external view returns (address);
    function usdc() external view returns (address);

    // Governance getters
    function treasury() external view returns (address);
    function hook() external view returns (address);
    function factory() external view returns (address);

    // Reserve getters
    function reserveAsset() external view returns (uint256);
    function reserveUsdc() external view returns (uint256);

    // Price (placeholder Q96)
    function priceX96() external view returns (uint256);

    // Liquidity tracking
    function totalLiquidity() external view returns (uint256);
    function liquidityOf(address who) external view returns (uint256);

    // Wiring (one-time)
    function setHook(address hook_) external;

    function bootstrapInitialize(uint256 amtA, uint256 amtU, int256 offsetBps) external;

    // Mint path (hook-only)
    function mintFromHook(address to, uint256 amtA, uint256 amtU) external returns (uint256 liquidityOut);

    // Burns (proportional, placeholder math)
    function burn(address to, uint256 liquidity) external returns (uint256 amountAssetOut, uint256 amountUsdcOut);

    // Swap (“supplicate”) placeholder CFMM
    function quoteSupplication(bool assetToUsdc, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, int256 priceDriftBps);

    function supplicate(address to, bool assetToUsdc, uint256 amountIn, uint256 minAmountOut)
        external
        returns (uint256 amountOut);
}