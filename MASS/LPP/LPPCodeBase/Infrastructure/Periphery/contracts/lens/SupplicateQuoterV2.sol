// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import '@lpp/lpp-protocol/contracts/libraries/SafeCast.sol';
import '@lpp/lpp-protocol/contracts/libraries/TickMath.sol';
import '@lpp/lpp-protocol/contracts/interfaces/ILPPPool.sol';
import '@lpp/lpp-protocol/contracts/interfaces/callback/ILPPSupplicateCallback.sol';

import '../interfaces/IQuoterV2.sol';
import '../base/PeripheryImmutableState.sol';
import '../libraries/Path.sol';
import '../libraries/PoolAddress.sol';
import '../libraries/CallbackValidation.sol';

/// Minimal local alias to invoke `supplicate` without touching protocol files
interface ILPPPoolSupplicate {
    function supplicate(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// Quoter V2 for LPP supplicates (off-chain quoting via revert data)
contract SupplicateQuoterV2 is ISupplicateQuoterV2, ILPPSupplicateCallback, PeripheryImmutableState {
    using Path for bytes;
    using SafeCast for uint256;

    // Safety cache for exact-output (matches Uniswap quoter pattern)
    uint256 private amountOutCached;

    // Per-hop output caches to avoid stack bloat in callers
    uint160 private _lastSqrtAfter;
    uint32  private _lastTicksCrossed; // kept for signature parity (we return 0)
    uint256 private _lastGasUsed;

    constructor(address _factory, address _WETH9) PeripheryImmutableState(_factory, _WETH9) {}

    // ───────── helpers ─────────

    function _poolAddress(address a, address b, uint24 f) private view returns (address) {
        return PoolAddress.computeAddress(factory, PoolAddress.getPoolKey(a, b, f));
    }

    function _poolView(address a, address b, uint24 f) private view returns (ILPPPool) {
        return ILPPPool(_poolAddress(a, b, f));
    }

    function _packPath(address a, uint24 f, address b) private pure returns (bytes memory) {
        return abi.encodePacked(a, f, b);
    }

    // ───────── callback ─────────

    function lppSupplicateCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes memory path
    ) external view override {
        require(amount0Delta > 0 || amount1Delta > 0, 'NO_DELTA');
        (address tokenIn, address tokenOut, uint24 fee) = path.decodeFirstPool();
        CallbackValidation.verifyCallback(factory, tokenIn, tokenOut, fee);

        (bool isExactInput, uint256 amountToPay, uint256 amountReceived) =
            amount0Delta > 0
                ? (tokenIn < tokenOut, uint256(amount0Delta), uint256(-amount1Delta))
                : (tokenOut < tokenIn, uint256(amount1Delta), uint256(-amount0Delta));

        ILPPPool poolV = _poolView(tokenIn, tokenOut, fee);
        (uint160 sqrtPriceX96After, int24 tickAfter, , , , , ) = poolV.slot0();

        if (isExactInput) {
            assembly {
                let p := mload(0x40)
                mstore(p, amountReceived)
                mstore(add(p, 0x20), sqrtPriceX96After)
                mstore(add(p, 0x40), tickAfter)
                revert(p, 96)
            }
        } else {
            if (amountOutCached != 0) require(amountReceived == amountOutCached, 'BAD_OUT');
            assembly {
                let p := mload(0x40)
                mstore(p, amountToPay)
                mstore(add(p, 0x20), sqrtPriceX96After)
                mstore(add(p, 0x40), tickAfter)
                revert(p, 96)
            }
        }
    }

    // ───────── revert parsing ─────────

    function _parseRevert(bytes memory reason)
        private
        pure
        returns (uint256 amount, uint160 sqrtPriceX96After, int24 tickAfter)
    {
        if (reason.length != 96) {
            if (reason.length < 68) revert('Unexpected error');
            assembly { reason := add(reason, 0x04) }
            revert(abi.decode(reason, (string)));
        }
        return abi.decode(reason, (uint256, uint160, int24));
    }

    // Store hop outputs into caches and return only primary amount
    function _storeHopOutputs(uint256 gasBefore, bytes memory reason) private returns (uint256 amount) {
        _lastGasUsed = gasBefore - gasleft();
        uint160 sa; int24 tickAfter;
        (amount, sa, tickAfter) = _parseRevert(reason);
        _lastSqrtAfter = sa;
        _lastTicksCrossed = 0; // no TickBitmap counting in this lightweight build
    }

    // ───────── single-hop helpers (keep caller stacks tiny) ─────────

    // returns: amountOut; side-effects: sets _lastSqrtAfter/_lastGasUsed/_lastTicksCrossed
    function _exactInputHop(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn
    ) private returns (uint256) {
        bool zeroForOne = tokenIn < tokenOut;
        address poolAddr = _poolAddress(tokenIn, tokenOut, fee);

        uint256 gasBefore = gasleft();
        try
            ILPPPoolSupplicate(poolAddr).supplicate(
                address(this),
                zeroForOne,
                amountIn.toInt256(),
                zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
                _packPath(tokenIn, fee, tokenOut)
            )
        {} catch (bytes memory reason) {
            return _storeHopOutputs(gasBefore, reason);
        }
        // Should never reach here (quoter relies on revert). If it does, make it fail deterministically.
        revert('NO_REVERT_INPUT');
    }

    // returns: amountIn; side-effects: sets _lastSqrtAfter/_lastGasUsed/_lastTicksCrossed
    function _exactOutputHop(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountOut
    ) private returns (uint256) {
        bool zeroForOne = tokenIn < tokenOut;
        address poolAddr = _poolAddress(tokenIn, tokenOut, fee);
        amountOutCached = amountOut;

        uint256 gasBefore = gasleft();

        // cache arguments to shrink stack
        int256 amt = -amountOut.toInt256();
        uint160 limit = zeroForOne
            ? TickMath.MIN_SQRT_RATIO + 1
            : TickMath.MAX_SQRT_RATIO - 1;
        bytes memory payload = _packPath(tokenOut, fee, tokenIn);

        try ILPPPoolSupplicate(poolAddr).supplicate(
            address(this),
            zeroForOne,
            amt,
            limit,
            payload
        )
        {} catch (bytes memory reason) {
            delete amountOutCached;
            return _storeHopOutputs(gasBefore, reason);
        }
        revert('NO_REVERT_OUTPUT');
    }

    // ───────── exact input ─────────

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        public
        override
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)
    {
        amountOut = _exactInputHop(params.tokenIn, params.tokenOut, params.fee, params.amountIn);
        sqrtPriceX96After = _lastSqrtAfter;
        initializedTicksCrossed = _lastTicksCrossed; // 0
        gasEstimate = _lastGasUsed;
    }

    function quoteExactInput(bytes memory path, uint256 amountIn)
        public
        override
        returns (uint256 amountOut, uint160[] memory sqrtAfterList, uint32[] memory initializedTicksCrossedList, uint256 gasEstimate)
    {
        uint256 pools = path.numPools();
        sqrtAfterList = new uint160[](pools);
        initializedTicksCrossedList = new uint32[](pools); // left zeroed

        uint256 i = 0;
        while (true) {
            (address tokenIn, address tokenOut, uint24 fee) = path.decodeFirstPool();

            // call hop (only one return value; other outputs via caches)
            uint256 ao = _exactInputHop(tokenIn, tokenOut, fee, amountIn);
            sqrtAfterList[i] = _lastSqrtAfter;
            // initializedTicksCrossedList[i] stays 0
            gasEstimate += _lastGasUsed;

            amountIn = ao;
            i++;

            if (!path.hasMultiplePools()) {
                return (amountIn, sqrtAfterList, initializedTicksCrossedList, gasEstimate);
            }
            path = path.skipToken();
        }
    }

    // ───────── exact output ─────────

    function quoteExactOutputSingle(QuoteExactOutputSingleParams memory params)
        public
        override
        returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)
    {
        amountIn = _exactOutputHop(params.tokenIn, params.tokenOut, params.fee, params.amount);
        sqrtPriceX96After = _lastSqrtAfter;
        initializedTicksCrossed = _lastTicksCrossed; // 0
        gasEstimate = _lastGasUsed;
    }

    function quoteExactOutput(bytes memory path, uint256 amountOut)
        public
        override
        returns (uint256 amountIn, uint160[] memory sqrtAfterList, uint32[] memory initializedTicksCrossedList, uint256 gasEstimate)
    {
        uint256 pools = path.numPools();
        sqrtAfterList = new uint160[](pools);
        initializedTicksCrossedList = new uint32[](pools); // left zeroed

        uint256 i = 0;
        while (true) {
            (address tokenOut, address tokenIn, uint24 fee) = path.decodeFirstPool();

            uint256 ai = _exactOutputHop(tokenIn, tokenOut, fee, amountOut);
            sqrtAfterList[i] = _lastSqrtAfter;
            gasEstimate += _lastGasUsed;
            // initializedTicksCrossedList[i] stays 0

            amountOut = ai;
            i++;

            if (!path.hasMultiplePools()) {
                return (amountOut, sqrtAfterList, initializedTicksCrossedList, gasEstimate);
            }
            path = path.skipToken();
        }
    }
}