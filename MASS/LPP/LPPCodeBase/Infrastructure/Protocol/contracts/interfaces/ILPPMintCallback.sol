// contracts/interfaces/ILPPMintCallback.sol
// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;

interface ILPPMintCallback {
    function lppMintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external;
}