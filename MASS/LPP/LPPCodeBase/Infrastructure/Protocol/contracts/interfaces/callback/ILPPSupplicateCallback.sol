// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

/// @title Callback for ILPPPoolActions#supplicate
/// @notice Any contract that calls ILPPPoolActions#supplicate must implement this interface
interface ILPPSupplicateCallback {
    /// @notice Called to `msg.sender` after executing a supplicate via ILPPPool#supplicate.
    /// @dev In the implementation you must pay the pool tokens owed for the supplicate.
    /// The caller of this method must be checked to be a LPPPool deployed by the canonical LPPFactory.
    /// amount0Delta and amount1Delta can both be 0 if no tokens were supplicated.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the supplicate. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the supplicate. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the ILPPPoolActions#supplicate call
    function lppSupplicateCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external;
}
