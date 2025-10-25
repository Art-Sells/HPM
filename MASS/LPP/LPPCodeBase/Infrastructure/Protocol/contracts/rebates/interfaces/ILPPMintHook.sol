// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.20;

interface ILPPMintHook {
    struct MintParamsLiquidity {
        address pool;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;   // desired liquidity (v0: minted as-is; surcharge is charged on top)
        address recipient;   // LP who will receive the position
        address payer;       // address from whom tokens will be pulled in callback + surcharge
    }

    /// @notice Mints via the pool while charging an in-kind rebate + retention on top (surcharge model v0).
    /// The surcharge is transferred to the RebateVault and Treasury during the mint callback.
    function mintWithRebate(MintParamsLiquidity calldata p) external returns (uint256 amount0, uint256 amount1, uint8 tier, uint16 shareBps);
}
