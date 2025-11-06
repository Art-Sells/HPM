// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPMintHook } from "./interfaces/ILPPMintHook.sol";
import { ILPPPool } from "./interfaces/ILPPPool.sol";
import { ILPPTreasury } from "./interfaces/ILPPTreasury.sol";
import { ILPPRebateVault } from "./interfaces/ILPPRebateVault.sol";

contract LPPMintHook is ILPPMintHook {
    ILPPTreasury public immutable treasury;
    ILPPRebateVault public immutable rebateVault;

    constructor(address _treasury, address _rebateVault) {
        treasury = ILPPTreasury(_treasury);
        rebateVault = ILPPRebateVault(_rebateVault);
    }

    function mintWithRebate(MintParams calldata params) external override returns (uint256 liquidityOut) {
        // NOTE: In real code, enforce equal-value within tolerance, compute TVL share, tiers, rebate/retention.
        // Scaffold: direct mint passthrough and emit placeholder event.
        liquidityOut = ILPPPool(params.pool).mint(params.to, params.amountAssetDesired, params.amountUsdcDesired);
        emit MCVQualified(params.to, params.pool, 0, 0);
    }
}
