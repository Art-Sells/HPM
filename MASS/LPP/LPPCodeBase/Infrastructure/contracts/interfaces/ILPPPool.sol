// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPPool {
    // --- Events ---
    event Mint(address indexed lp, uint256 amountAsset, uint256 amountUsdc, uint256 liquidity);
    event Burn(address indexed lp, uint256 liquidity, uint256 amountAssetOut, uint256 amountUsdcOut);
    event Supplicate(address indexed caller, bool assetToUsdc, uint256 amountIn, uint256 amountOut);
    event HookSet(address indexed hook);
    event Initialized(uint256 amountAsset, uint256 amountUsdc);

    // --- Tokens ---
    function asset() external view returns (address);
    function usdc() external view returns (address);

    // --- Reserves ---
    function reserveAsset() external view returns (uint256);
    function reserveUsdc() external view returns (uint256);

    // --- Price (placeholder) ---
    function priceX96() external view returns (uint256);

    // --- Liquidity accounting ---
    function liquidityOf(address who) external view returns (uint256);
    function totalLiquidity() external view returns (uint256);

    // --- Hook / Minting control ---
    /**
     * @notice Treasury wires the authorized LPPMintHook once, then immutable.
     */
    function setHook(address hook_) external;

    /**
     * @notice One-time bootstrap (no rebates) — callable only by the Hook.
     */
    function bootstrapInitialize(uint256 amtA, uint256 amtU) external;

    /**
     * @notice Normal mint path — callable only by the Hook, after rebates/retentions are applied in LPPMintHook.
     */
    function mintFromHook(address to, uint256 amtA, uint256 amtU) external returns (uint256 liquidityOut);

    // --- Burns ---
    function burn(address to, uint256 liquidity) external returns (uint256 amountAssetOut, uint256 amountUsdcOut);

    // --- Quotes & Rebalances ---
    function quoteSupplication(bool assetToUsdc, uint256 amountIn) external view returns (uint256 amountOut, int256 priceDriftBps);
    function supplicate(address to, bool assetToUsdc, uint256 amountIn, uint256 minAmountOut) external returns (uint256 amountOut);
}