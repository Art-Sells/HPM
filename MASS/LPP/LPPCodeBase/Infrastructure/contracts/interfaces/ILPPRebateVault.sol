// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPRebateVault {
    function recordRebate(address token, address to, uint256 amount) external;
}
