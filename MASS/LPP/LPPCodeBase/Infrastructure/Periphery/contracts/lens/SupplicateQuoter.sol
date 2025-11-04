// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import "../interfaces/IQuoter.sol";
import "../base/PeripheryImmutableState.sol";
import "../libraries/Path.sol";
import "../libraries/PoolAddress.sol";
import "../libraries/CallbackValidation.sol";
import "@lpp/lpp-protocol/contracts/interfaces/callback/ILPPSupplicateCallback.sol";

/// ─────────────────────────────────────────────────────────────────────────────
/// Local minimal helpers (no protocol edits / no extra protocol libs compiled)
/// ─────────────────────────────────────────────────────────────────────────────
library SafeCastMini {
    function toInt256(uint256 x) internal pure returns (int256 y) {
        require(x < 2**255, "SafeCast: overflow");
        y = int256(x);
    }
}

library TickMathMini {
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO =
        1461446703485210103287273052203988822378723970342;
}

interface ILPPPoolSupplicate {
    function supplicate(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @title Provides quotes for supplicates
/// @notice Get expected amount out/in for a supplicate by catching the callback revert payload
/// @dev Not gas-efficient; off-chain use.
contract SupplicateQuoter is ISupplicateQuoter, ILPPSupplicateCallback, PeripheryImmutableState {
    using Path for bytes;
    using SafeCastMini for uint256;

    uint256 private amountOutCached;

    constructor(address _factory, address _WETH9) PeripheryImmutableState(_factory, _WETH9) {}

    // ─────────────────────────────────────────────────────────────────────────
    // Pool resolver (no protocol edits)
    // ─────────────────────────────────────────────────────────────────────────
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) private view returns (ILPPPoolSupplicate) {
        return ILPPPoolSupplicate(
            PoolAddress.computeAddress(factory, PoolAddress.getPoolKey(tokenA, tokenB, fee))
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Callback: revert with the numeric quote
    // ─────────────────────────────────────────────────────────────────────────
    function lppSupplicateCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata path
    ) external view override {
        require(amount0Delta > 0 || amount1Delta > 0, "NO_DELTA");
        (address tokenIn, address tokenOut, uint24 fee) = path.decodeFirstPool();
        CallbackValidation.verifyCallback(factory, tokenIn, tokenOut, fee);

        (bool isExactInput, uint256 amountToPay, uint256 amountReceived) =
            amount0Delta > 0
                ? (tokenIn < tokenOut, uint256(amount0Delta), uint256(-amount1Delta))
                : (tokenOut < tokenIn, uint256(amount1Delta), uint256(-amount0Delta));

        if (isExactInput) {
            assembly {
                let p := mload(0x40)
                mstore(p, amountReceived)
                revert(p, 32)
            }
        } else {
            if (amountOutCached != 0) require(amountReceived == amountOutCached, "BAD_OUT");
            assembly {
                let p := mload(0x40)
                mstore(p, amountToPay)
                revert(p, 32)
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────
    function parseRevertReason(bytes memory reason) private pure returns (uint256) {
        if (reason.length != 32) {
            if (reason.length < 68) revert("Unexpected error");
            assembly { reason := add(reason, 0x04) }
            revert(abi.decode(reason, (string)));
        }
        return abi.decode(reason, (uint256));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Quoting
    // ─────────────────────────────────────────────────────────────────────────
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) public override returns (uint256 amountOut) {
        bool zeroForOne = tokenIn < tokenOut;

        try
            getPool(tokenIn, tokenOut, fee).supplicate(
                address(this),
                zeroForOne,
                amountIn.toInt256(),
                sqrtPriceLimitX96 == 0
                    ? (zeroForOne ? TickMathMini.MIN_SQRT_RATIO + 1 : TickMathMini.MAX_SQRT_RATIO - 1)
                    : sqrtPriceLimitX96,
                abi.encodePacked(tokenIn, fee, tokenOut)
            )
        {} catch (bytes memory reason) {
            return parseRevertReason(reason);
        }
    }

    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        override
        returns (uint256 amountOut)
    {
        while (true) {
            bool hasMultiple = path.hasMultiplePools();
            (address tokenIn, address tokenOut, uint24 fee) = path.decodeFirstPool();
            amountIn = quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0);
            if (hasMultiple) {
                path = path.skipToken();
            } else {
                return amountIn;
            }
        }
    }

    function quoteExactOutputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountOut,
        uint160 sqrtPriceLimitX96
    ) public override returns (uint256 amountIn) {
        bool zeroForOne = tokenIn < tokenOut;

        if (sqrtPriceLimitX96 == 0) amountOutCached = amountOut;
        try
            getPool(tokenIn, tokenOut, fee).supplicate(
                address(this),
                zeroForOne,
                -amountOut.toInt256(),
                sqrtPriceLimitX96 == 0
                    ? (zeroForOne ? TickMathMini.MIN_SQRT_RATIO + 1 : TickMathMini.MAX_SQRT_RATIO - 1)
                    : sqrtPriceLimitX96,
                abi.encodePacked(tokenOut, fee, tokenIn)
            )
        {} catch (bytes memory reason) {
            if (sqrtPriceLimitX96 == 0) delete amountOutCached;
            return parseRevertReason(reason);
        }
    }

    function quoteExactOutput(bytes memory path, uint256 amountOut)
        external
        override
        returns (uint256 amountIn)
    {
        while (true) {
            bool hasMultiple = path.hasMultiplePools();
            (address tokenOut, address tokenIn, uint24 fee) = path.decodeFirstPool();
            amountOut = quoteExactOutputSingle(tokenIn, tokenOut, fee, amountOut, 0);
            if (hasMultiple) {
                path = path.skipToken();
            } else {
                return amountOut;
            }
        }
    }
}