// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IERC20.sol";

library SafeERC20 {
    function safeTransferFrom(IERC20 t, address from, address to, uint256 v) internal {
        bool ok = t.transferFrom(from, to, v);
        require(ok, "ERC20: transferFrom failed");
    }

    function safeTransfer(IERC20 t, address to, uint256 v) internal {
        bool ok = t.transfer(to, v);
        require(ok, "ERC20: transfer failed");
    }
}