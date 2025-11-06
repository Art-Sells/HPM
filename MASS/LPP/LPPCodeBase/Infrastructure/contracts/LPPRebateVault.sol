// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPRebateVault } from "./interfaces/ILPPRebateVault.sol";

contract LPPRebateVault is ILPPRebateVault {
    event RebateRecorded(address indexed token, address indexed to, uint256 amount);

    function recordRebate(address token, address to, uint256 amount) external override {
        // Scaffold: just emit. Wire real accounting / vesting later.
        emit RebateRecorded(token, to, amount);
    }
}
