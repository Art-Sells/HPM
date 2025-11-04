// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import '@lpp/lpp-protocol/contracts/libraries/SafeCast.sol';
import '@lpp/lpp-protocol/contracts/libraries/TickMath.sol';

import './interfaces/ISupplicateRouter.sol';
import './base/PeripheryImmutableState.sol';
import './base/PeripheryValidation.sol';
import './base/PeripheryPaymentsWithFee.sol';
import './base/Multicall.sol';
import './base/SelfPermit.sol';
import './libraries/Path.sol';
import './libraries/PoolAddress.sol';
import './libraries/CallbackValidation.sol';
import './interfaces/external/IWETH9.sol';

/// @dev Minimal local view of the pool with the renamed method.
//      (No protocol edits; just cast the computed address to this interface.)
interface ILPPPoolSupplicate {
    function supplicate(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @title  Supplicate Router
/// @notice Router for stateless execution of supplicates
contract SupplicateRouter is
    ISupplicateRouter,
    PeripheryImmutableState,
    PeripheryValidation,
    PeripheryPaymentsWithFee,
    Multicall,
    SelfPermit
{
    using Path for bytes;
    using SafeCast for uint256;

    /// @dev Placeholder for amountInCached (exact-output path)
    uint256 private constant DEFAULT_AMOUNT_IN_CACHED = type(uint256).max;

    /// @dev Transient storage for returning computed amountIn on exact-output
    uint256 private amountInCached = DEFAULT_AMOUNT_IN_CACHED;

    constructor(address _factory, address _WETH9) PeripheryImmutableState(_factory, _WETH9) {}

    /// @dev Returns the pool for the given token pair and fee. The pool may or may not exist.
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) private view returns (ILPPPoolSupplicate) {
        return ILPPPoolSupplicate(
            PoolAddress.computeAddress(factory, PoolAddress.getPoolKey(tokenA, tokenB, fee))
        );
    }

    struct SupplicateCallbackData {
        bytes path;
        address payer;
    }

    /// @inheritdoc ILPPSupplicateCallback
    function lppSupplicateCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata _data
    ) external override {
        require(amount0Delta > 0 || amount1Delta > 0, 'NO_DELTA'); // supplicates entirely within 0-liquidity regions are not supported
        SupplicateCallbackData memory data = abi.decode(_data, (SupplicateCallbackData));
        (address tokenIn, address tokenOut, uint24 fee) = data.path.decodeFirstPool();
        CallbackValidation.verifyCallback(factory, tokenIn, tokenOut, fee);

        (bool isExactInput, uint256 amountToPay) =
            amount0Delta > 0
                ? (tokenIn < tokenOut, uint256(amount0Delta))
                : (tokenOut < tokenIn, uint256(amount1Delta));

        if (isExactInput) {
            // pay input for this hop
            pay(tokenIn, data.payer, msg.sender, amountToPay);
        } else {
            // either continue multi-hop exact-output or finish
            if (data.path.hasMultiplePools()) {
                data.path = data.path.skipToken();
                exactOutputInternal(amountToPay, msg.sender, 0, data);
            } else {
                amountInCached = amountToPay;
                // final hop: invert for payment
                tokenIn = tokenOut;
                pay(tokenIn, data.payer, msg.sender, amountToPay);
            }
        }
    }

    /// @dev Performs a single exact input supplicate
    function exactInputInternal(
        uint256 amountIn,
        address recipient,
        uint160 sqrtPriceLimitX96,
        SupplicateCallbackData memory data
    ) private returns (uint256 amountOut) {
        // allow supplicating to the router address with address(0)
        if (recipient == address(0)) recipient = address(this);

        (address tokenIn, address tokenOut, uint24 fee) = data.path.decodeFirstPool();
        bool zeroForOne = tokenIn < tokenOut;

        (int256 amount0, int256 amount1) =
            getPool(tokenIn, tokenOut, fee).supplicate(
                recipient,
                zeroForOne,
                amountIn.toInt256(),
                sqrtPriceLimitX96 == 0
                    ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                    : sqrtPriceLimitX96,
                abi.encode(data)
            );

        return uint256(-(zeroForOne ? amount1 : amount0));
    }

    /// @inheritdoc ISupplicateRouter
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        override
        checkDeadline(params.deadline)
        returns (uint256 amountOut)
    {
        amountOut = exactInputInternal(
            params.amountIn,
            params.recipient,
            params.sqrtPriceLimitX96,
            SupplicateCallbackData({
                path: abi.encodePacked(params.tokenIn, params.fee, params.tokenOut),
                payer: msg.sender
            })
        );
        require(amountOut >= params.amountOutMinimum, 'Too little received');
    }

    /// @inheritdoc ISupplicateRouter
    function exactInput(ExactInputParams memory params)
        external
        payable
        override
        checkDeadline(params.deadline)
        returns (uint256 amountOut)
    {
        address payer = msg.sender; // msg.sender pays for the first hop
        while (true) {
            bool hasMultiplePools = params.path.hasMultiplePools();

            // outputs of prior supplicates become inputs to subsequent ones
            params.amountIn = exactInputInternal(
                params.amountIn,
                hasMultiplePools ? address(this) : params.recipient, // custody for intermediate hops
                0,
                SupplicateCallbackData({
                    path: params.path.getFirstPool(), // only the first pool in the path is necessary
                    payer: payer
                })
            );

            if (hasMultiplePools) {
                payer = address(this); // at this point, the caller has paid
                params.path = params.path.skipToken();
            } else {
                amountOut = params.amountIn;
                break;
            }
        }
        require(amountOut >= params.amountOutMinimum, 'Too little received');
    }

    /// @dev Performs a single exact output supplicate
    function exactOutputInternal(
        uint256 amountOut,
        address recipient,
        uint160 sqrtPriceLimitX96,
        SupplicateCallbackData memory data
    ) private returns (uint256 amountIn) {
        // allow supplicating to the router address with address(0)
        if (recipient == address(0)) recipient = address(this);

        (address tokenOut, address tokenIn, uint24 fee) = data.path.decodeFirstPool();
        bool zeroForOne = tokenIn < tokenOut;

        (int256 amount0Delta, int256 amount1Delta) =
            getPool(tokenIn, tokenOut, fee).supplicate(
                recipient,
                zeroForOne,
                -int256(amountOut),
                sqrtPriceLimitX96 == 0
                    ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                    : sqrtPriceLimitX96,
                abi.encode(data)
            );

        uint256 amountOutReceived;
        (amountIn, amountOutReceived) = zeroForOne
            ? (uint256(amount0Delta), uint256(-amount1Delta))
            : (uint256(amount1Delta), uint256(-amount0Delta));

        // if no price limit has been specified, require full output delivered
        if (sqrtPriceLimitX96 == 0) require(amountOutReceived == amountOut, 'Insufficient output');
    }

    /// @inheritdoc ISupplicateRouter
    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        payable
        override
        checkDeadline(params.deadline)
        returns (uint256 amountIn)
    {
        // avoid an SLOAD by using the supplicate return data
        amountIn = exactOutputInternal(
            params.amountOut,
            params.recipient,
            params.sqrtPriceLimitX96,
            SupplicateCallbackData({
                path: abi.encodePacked(params.tokenOut, params.fee, params.tokenIn),
                payer: msg.sender
            })
        );

        require(amountIn <= params.amountInMaximum, 'Too much requested');
        // reset even though we don't use it in the single hop case
        amountInCached = DEFAULT_AMOUNT_IN_CACHED;
    }

    /// @inheritdoc ISupplicateRouter
    function exactOutput(ExactOutputParams calldata params)
        external
        payable
        override
        checkDeadline(params.deadline)
        returns (uint256 amountIn)
    {
        // payer is fixed to msg.sender for the "final" exact-output hop (which executes first)
        exactOutputInternal(
            params.amountOut,
            params.recipient,
            0,
            SupplicateCallbackData({path: params.path, payer: msg.sender})
        );

        amountIn = amountInCached;
        require(amountIn <= params.amountInMaximum, 'Too much requested');
        amountInCached = DEFAULT_AMOUNT_IN_CACHED;
    }
}