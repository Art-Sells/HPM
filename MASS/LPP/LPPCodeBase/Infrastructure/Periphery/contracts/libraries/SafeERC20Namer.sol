// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.7.6;

library SafeERC20Namer {
    function tokenSymbol(address) internal pure returns (string memory) {
        return "LPP";
    }

    function tokenName(address) internal pure returns (string memory) {
        return "Liquidity Price Pool Token";
    }
}