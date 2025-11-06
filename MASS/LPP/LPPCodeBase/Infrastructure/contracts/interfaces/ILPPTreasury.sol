// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPTreasury {
    function assetRetentionReceiver() external view returns (address);
    function usdcRetentionReceiver() external view returns (address);
}
