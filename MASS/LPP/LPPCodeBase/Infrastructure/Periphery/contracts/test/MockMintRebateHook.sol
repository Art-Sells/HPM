// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;

// Match the interface your pool expects. Names here are illustrative.
// If your pool asks a hook for `rebateRequired(pool)` and calls `onMint(...)`,
// keep those exact selectors.
interface ILPPMintHook {
    function rebateRequired(address pool) external view returns (uint256);
    function onMint(
        address pool,
        address sender,
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        bytes calldata data
    ) external;
}

contract MockMintRebateHook is ILPPMintHook {
    uint256 public rebateWei;

    function setRebateWei(uint256 _rebateWei) external { rebateWei = _rebateWei; }

    function rebateRequired(address) external view override returns (uint256) {
        return rebateWei;
    }

    function onMint(
        address,
        address,
        address,
        int24,
        int24,
        uint128,
        bytes calldata
    ) external override {
        // no-op in tests
    }
}