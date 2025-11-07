// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPPool } from "./interfaces/ILPPPool.sol";

/**
 * @title LPPPool
 * @notice Minimal placeholder pool for LPP v1. All liquidity creation is gated:
 *         - One-time bootstrap via Hook:    bootstrapInitialize()
 *         - Normal mints via Hook only:     mintFromHook()
 *         No public mint() exists to ensure rebates/retentions are always applied in LPPMintHook.
 */
contract LPPPool is ILPPPool {
    
    // Immutable token addresses
    address public immutable override asset;
    address public immutable override usdc;

    // Governance/authority
    address public immutable treasury;  // authority allowed to set the hook exactly once
    address public hook;                // LPPMintHook set by Treasury

    // Reserves (naive placeholder math for now)
    uint256 public override reserveAsset;
    uint256 public override reserveUsdc;

    // Price placeholder (Q96 style)
    uint256 private _priceX96;

    // Liquidity accounting (simple placeholder)
    mapping(address => uint256) private _liq;
    uint256 public override totalLiquidity;

    // Init state
    bool public initialized;

    // --- Modifiers ---
    modifier nonZero(uint256 x) {
        require(x > 0, "zero");
        _;
    }

    modifier onlyTreasury() {
        require(msg.sender == treasury, "only treasury");
        _;
    }

    modifier onlyHook() {
        require(msg.sender == hook, "only hook");
        _;
    }

    constructor(address _asset, address _usdc, address _treasury) {
        require(_asset != address(0) && _usdc != address(0) && _treasury != address(0), "zero");
        asset = _asset;
        usdc = _usdc;
        treasury = _treasury;

        // placeholder fixed price = 1.0
        _priceX96 = 1 << 96;
    }

    // --- Views ---
    function priceX96() external view override returns (uint256) {
        return _priceX96;
    }

    function liquidityOf(address who) external view override returns (uint256) {
        return _liq[who];
    }

    // --- Hook wiring (one-time) ---
    function setHook(address hook_) external override onlyTreasury {
        require(hook == address(0), "hook set");
        require(hook_ != address(0), "zero hook");
        hook = hook_;
        emit HookSet(hook_);
    }

    // --- Bootstrap: one-time seed, must go through Hook (no rebates at bootstrap) ---
    function bootstrapInitialize(uint256 amtA, uint256 amtU)
        external
        override
        onlyHook
        nonZero(amtA)
        nonZero(amtU)
    {
        require(!initialized, "already init");
        _internalMint(treasury, amtA, amtU); // seed to treasury (or another address you prefer)
        initialized = true;
        emit Initialized(amtA, amtU);
    }

    // --- Normal mint: Hook-only (rebates/retentions already applied in LPPMintHook) ---
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

    // --- Internal mint primitive (no access control here; only callable from guarded entries) ---
    function _internalMint(address to, uint256 amountAssetDesired, uint256 amountUsdcDesired)
        internal
        returns (uint256 liquidityOut)
    {
        // Naive “liquidity = sum of tokens” placeholder for v1 scaffolding
        liquidityOut = amountAssetDesired + amountUsdcDesired;

        reserveAsset += amountAssetDesired;
        reserveUsdc  += amountUsdcDesired;

        totalLiquidity += liquidityOut;
        _liq[to] += liquidityOut;

        emit Mint(to, amountAssetDesired, amountUsdcDesired, liquidityOut);
    }

    // --- Burns (proportional, placeholder math) ---
    function burn(address to, uint256 liquidity)
        external
        override
        nonZero(liquidity)
        returns (uint256 amountAssetOut, uint256 amountUsdcOut)
    {
        uint256 bal = _liq[msg.sender];
        require(bal >= liquidity, "insufficient liq");
        _liq[msg.sender] = bal - liquidity;

        // Remove from total first to avoid division by zero quirks
        uint256 totalAfter = totalLiquidity - liquidity;
        // Proportional distribution against post-burn denominator (simple placeholder)
        uint256 denom = liquidity + totalAfter;

        amountAssetOut = (reserveAsset * liquidity) / denom;
        amountUsdcOut  = (reserveUsdc  * liquidity) / denom;

        reserveAsset -= amountAssetOut;
        reserveUsdc  -= amountUsdcOut;
        totalLiquidity = totalAfter;

        emit Burn(to, liquidity, amountAssetOut, amountUsdcOut);
    }

    // --- Quotes & rebalances (supplicate) — placeholder CFMM ---
    function quoteSupplication(bool assetToUsdc, uint256 amountIn)
        external
        view
        override
        returns (uint256 amountOut, int256 priceDriftBps)
    {
        require(reserveUsdc > 0 && reserveAsset > 0, "empty reserves");

        if (assetToUsdc) {
            // out = in * R_usdc / (R_asset + in)
            amountOut = (amountIn * reserveUsdc) / (reserveAsset + amountIn);
            priceDriftBps = int256((amountIn * 10_000) / (reserveAsset + 1));
        } else {
            // out = in * R_asset / (R_usdc + in)
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
}