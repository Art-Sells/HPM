// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.7.5;
pragma abicoder v2;

/// @title SupplicateQuoterV2 Interface
/// @notice Supports quoting the calculated amounts from exact input or exact output supplicates.
/// @notice For each pool also tells you the number of initialized ticks crossed and the sqrt price of the pool after the supplicate.
/// @dev These functions are not marked view because they rely on calling non-view functions and reverting
/// to compute the result. They are also not gas efficient and should not be called on-chain.
interface ISupplicateQuoterV2 {
    /// @notice Returns the amount out received for a given exact input supplicate without executing the supplicate
    /// @param path The path of the supplicate, i.e. each token pair and the pool fee
    /// @param amountIn The amount of the first token to supplicate
    /// @return amountOut The amount of the last token that would be received
    /// @return sqrtPriceX96AfterList List of the sqrt price after the supplicate for each pool in the path
    /// @return initializedTicksCrossedList List of the initialized ticks that the supplicate crossed for each pool in the path
    /// @return gasEstimate The estimate of the gas that the supplicate consumes
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (
            uint256 amountOut,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        );

    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Returns the amount out received for a given exact input but for a supplicate of a single pool
    /// @param params The params for the quote, encoded as `QuoteExactInputSingleParams`
    /// tokenIn The token being supplicated in
    /// tokenOut The token being supplicated out
    /// fee The fee of the token pool to consider for the pair
    /// amountIn The desired input amount
    /// sqrtPriceLimitX96 The price limit of the pool that cannot be exceeded by the supplicate
    /// @return amountOut The amount of `tokenOut` that would be received
    /// @return sqrtPriceX96After The sqrt price of the pool after the supplicate
    /// @return initializedTicksCrossed The number of initialized ticks that the supplicate crossed
    /// @return gasEstimate The estimate of the gas that the supplicate consumes
    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );

    /// @notice Returns the amount in required for a given exact output supplicate without executing the supplicate
    /// @param path The path of the supplicate, i.e. each token pair and the pool fee. Path must be provided in reverse order
    /// @param amountOut The amount of the last token to receive
    /// @return amountIn The amount of first token required to be paid
    /// @return sqrtPriceX96AfterList List of the sqrt price after the supplicate for each pool in the path
    /// @return initializedTicksCrossedList List of the initialized ticks that the supplicate crossed for each pool in the path
    /// @return gasEstimate The estimate of the gas that the supplicate consumes
    function quoteExactOutput(bytes memory path, uint256 amountOut)
        external
        returns (
            uint256 amountIn,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        );

    struct QuoteExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amount;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Returns the amount in required to receive the given exact output amount but for a supplicate of a single pool
    /// @param params The params for the quote, encoded as `QuoteExactOutputSingleParams`
    /// tokenIn The token being supplicated in
    /// tokenOut The token being supplicated out
    /// fee The fee of the token pool to consider for the pair
    /// amountOut The desired output amount
    /// sqrtPriceLimitX96 The price limit of the pool that cannot be exceeded by the supplicate
    /// @return amountIn The amount required as the input for the supplicate in order to receive `amountOut`
    /// @return sqrtPriceX96After The sqrt price of the pool after the supplicate
    /// @return initializedTicksCrossed The number of initialized ticks that the supplicate crossed
    /// @return gasEstimate The estimate of the gas that the supplicate consumes
    function quoteExactOutputSingle(QuoteExactOutputSingleParams memory params)
        external
        returns (
            uint256 amountIn,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );
}