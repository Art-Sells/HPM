// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "./external/IERC20.sol";
import { ILPPPool } from "./interfaces/ILPPPool.sol";

contract LPPPool is ILPPPool {
    // ─────────────────────────────────────────────────────────────────────────────
    // Immutable wiring
    // ─────────────────────────────────────────────────────────────────────────────
    address public immutable override asset;
    address public immutable override usdc;

    address public immutable override treasury; // project-level authority
    address public immutable override factory;  // deploying factory (authorized to set hook)
    address public override hook;               // optional hook (unused in Phase 0, kept for future)

    // ─────────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────────
    uint256 public override reserveAsset;
    uint256 public override reserveUsdc;

    uint256 private _priceX96;                  // target price (U/A) in Q96 set at bootstrap
    int16   public override targetOffsetBps;    // persist the offset sign/magnitude (e.g. ±500)
    mapping(address => uint256) private _liq;
    uint256 public override totalLiquidity;

    bool public initialized;

    event Sync(uint112 reserve0, uint112 reserve1);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );

    // token ordering cache for V2 shape
    bool private immutable _assetIsToken0;

    // V2 timestamp (like blockTimestampLast in pairs)
    uint32 private _blockTimestampLast;

    // ─────────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────────────
    modifier nonZero(uint256 x) { require(x > 0, "zero"); _; }
    modifier onlyTreasuryOrFactory() {
        require(msg.sender == treasury || msg.sender == factory, "only auth");
        _;
    }

    constructor(address _asset, address _usdc, address _treasury, address _factory) {
        require(_asset != address(0) && _usdc != address(0) && _treasury != address(0) && _factory != address(0), "zero");
        asset = _asset;
        usdc  = _usdc;
        treasury = _treasury;
        factory  = _factory;

        // V2 token0/1 ordering: lowest address is token0
        _assetIsToken0 = (asset < usdc);

        _priceX96 = 1 << 96; // default until bootstrap
        _blockTimestampLast = uint32(block.timestamp); // initialize
    }

    // Views
    function priceX96() external view override returns (uint256) { return _priceX96; }
    function liquidityOf(address who) external view override returns (uint256) { return _liq[who]; }

    // Governance wiring
    function setHook(address hook_) external override onlyTreasuryOrFactory {
        require(hook == address(0), "hook set");
        require(hook_ != address(0), "zero hook");
        hook = hook_;
        emit HookSet(hook_);
    }

    /// @notice Initialize reserves and set target price/offset.
    function bootstrapInitialize(uint256 amtA, uint256 amtU, int256 offsetBps)
        external
        override
        onlyTreasuryOrFactory
        nonZero(amtA)
        nonZero(amtU)
    {
        require(!initialized, "already init");

        _internalMint(treasury, amtA, amtU);

        // base price = usdc/asset in Q96, then apply offset
        uint256 baseX96 = (amtU << 96) / amtA;
        int256 combined = int256(uint256(baseX96)) * (10000 + offsetBps);
        require(combined > 0, "bad offset");
        _priceX96 = uint256(combined) / 10000;

        // persist offset sign/magnitude (bounds check optional)
        require(offsetBps >= -10000 && offsetBps <= 10000, "offset out of bounds");
        targetOffsetBps = int16(offsetBps);

        initialized = true;
        emit Initialized(amtA, amtU);

        _touchAndSync();
    }

    function mintFromHook(address to, uint256 amtA, uint256 amtU)
        external
        override
        onlyTreasuryOrFactory
        nonZero(amtA)
        nonZero(amtU)
        returns (uint256 liquidityOut)
    {
        liquidityOut = _internalMint(to, amtA, amtU);
        _touchAndSync();
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

        _touchAndSync();
    }

    // Quotes & Supplication (placeholder CFMM math)
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

    function supplicate(address payer, address to, bool assetToUsdc, uint256 amountIn, uint256 minAmountOut)
        external
        override
        nonZero(amountIn)
        returns (uint256 amountOut)
    {
        (amountOut, ) = this.quoteSupplication(assetToUsdc, amountIn);
        require(amountOut >= minAmountOut, "slippage");

        address a = asset;
        address u = usdc;

        if (assetToUsdc) {
            require(IERC20(a).transferFrom(payer, address(this), amountIn), "pull asset fail");
            reserveAsset += amountIn;
            require(reserveUsdc >= amountOut, "insufficient usdc");
            reserveUsdc -= amountOut;
            require(IERC20(u).transfer(to, amountOut), "push usdc fail");
        } else {
            require(IERC20(u).transferFrom(payer, address(this), amountIn), "pull usdc fail");
            reserveUsdc += amountIn;
            require(reserveAsset >= amountOut, "insufficient asset");
            reserveAsset -= amountOut;
            require(IERC20(a).transfer(to, amountOut), "push asset fail");
        }

        emit Supplicate(msg.sender, assetToUsdc, amountIn, amountOut);

        // V2-style Swap (map to token0/1 amounts)
        uint256 amount0In; uint256 amount1In; uint256 amount0Out; uint256 amount1Out;
        if (_assetIsToken0) {
            if (assetToUsdc) { // asset in, usdc out
                amount0In  = amountIn;
                amount1Out = amountOut;
            } else {           // usdc in, asset out
                amount1In  = amountIn;
                amount0Out = amountOut;
            }
        } else {
            if (assetToUsdc) { // asset in, usdc out ; here token0=usdc
                amount1In  = amountIn;
                amount0Out = amountOut;
            } else {           // usdc in, asset out
                amount0In  = amountIn;
                amount1Out = amountOut;
            }
        }
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);

        _touchAndSync();
    }

    // Donations (increase reserves without minting LP shares)
    function donateToReserves(bool isUsdc, uint256 amount)
        external
        override
        nonZero(amount)
    {
        if (isUsdc) {
            uint256 beforeRes = reserveUsdc;
            uint256 bal = IERC20(usdc).balanceOf(address(this));
            if (bal < beforeRes + amount) {
                require(IERC20(usdc).transferFrom(msg.sender, address(this), amount), "donate usdc pull fail");
                bal = IERC20(usdc).balanceOf(address(this));
            }
            require(bal >= beforeRes + amount, "donate usdc shortage");
            reserveUsdc = beforeRes + amount;
        } else {
            uint256 beforeRes = reserveAsset;
            uint256 bal = IERC20(asset).balanceOf(address(this));
            if (bal < beforeRes + amount) {
                require(IERC20(asset).transferFrom(msg.sender, address(this), amount), "donate asset pull fail");
                bal = IERC20(asset).balanceOf(address(this));
            }
            require(bal >= beforeRes + amount, "donate asset shortage");
            reserveAsset = beforeRes + amount;
        }

        emit Donation(isUsdc, amount);
        _touchAndSync();
    }

    function getReserves()
        public
        view
        override
        returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)
    {
        if (_assetIsToken0) {
            reserve0 = uint112(reserveAsset);
            reserve1 = uint112(reserveUsdc);
        } else {
            reserve0 = uint112(reserveUsdc);
            reserve1 = uint112(reserveAsset);
        }
        blockTimestampLast = _blockTimestampLast;
    }

    function slot0()
        external
        view
        override
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        // Determine token0/token1 price (token1/token0) in Q96
        uint256 pxQ96;
        if (_assetIsToken0) {
            // token0 = asset, token1 = usdc => price = usdc/asset
            if (reserveAsset > 0 && reserveUsdc > 0) {
                pxQ96 = (reserveUsdc << 96) / reserveAsset;
            } else {
                pxQ96 = _priceX96;
            }
        } else {
            // token0 = usdc, token1 = asset => price = asset/usdc
            if (reserveAsset > 0 && reserveUsdc > 0) {
                pxQ96 = (reserveAsset << 96) / reserveUsdc;
            } else {
                // invert stored price (usdc/asset) -> (asset/usdc)
                require(_priceX96 > 0, "price=0");
                pxQ96 = (uint256(1) << 192) / _priceX96; // (2^96 * 2^96) / priceQ96
            }
        }

        // sqrtPriceX96 = sqrt(pxQ96) * 2^48  (since sqrt(Q96) => << 48)
        uint256 sp = _isqrt(pxQ96) << 48;
        require(sp <= type(uint160).max, "sqrt overflow");
        sqrtPriceX96 = uint160(sp);

        // minimal fixed fields (we are not running a V3 oracle here)
        tick = 0;
        observationIndex = 0;
        observationCardinality = 1;
        observationCardinalityNext = 1;
        feeProtocol = 0;
        unlocked = true;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Small helpers
    // ─────────────────────────────────────────────────────────────────────────────
    function _currentTimestamp32() private view returns (uint32) {
        return uint32(block.timestamp);
    }

    function _touchAndSync() private {
        _blockTimestampLast = _currentTimestamp32();
        (uint112 r0, uint112 r1, ) = getReserves();
        emit Sync(r0, r1);
    }

    // integer sqrt (Babylonian, capped)
    function _isqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        uint256 y = x;
        z = 1;
        if (y >> 128 > 0) { y >>= 128; z <<= 64; }
        if (y >>  64 > 0) { y >>=  64; z <<= 32; }
        if (y >>  32 > 0) { y >>=  32; z <<= 16; }
        if (y >>  16 > 0) { y >>=  16; z <<=  8; }
        if (y >>   8 > 0) { y >>=   8; z <<=  4; }
        if (y >>   4 > 0) { y >>=   4; z <<=  2; }
        if (y >>   2 > 0) { z <<= 1; }
        unchecked {
            for (uint8 i = 0; i < 7; i++) {
                uint256 nz = (z + x / z) >> 1;
                if (nz == z) break;
                z = nz;
            }
            if (z * z > x) z -= 1;
        }
    }
}