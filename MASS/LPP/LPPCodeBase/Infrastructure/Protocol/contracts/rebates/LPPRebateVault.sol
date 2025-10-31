// contracts/rebates/LPPRebateVault.sol
// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.20;

import "./interfaces/IERC20.sol";

contract LPPRebateVault {
    address public owner;

    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);
    event Swept(address indexed token, address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _owner) {
        owner = _owner;
    }

    function setOwner(address _owner) external onlyOwner {
        emit OwnerUpdated(owner, _owner);
        owner = _owner;
    }

    /// @notice Owner can sweep tokens (e.g., to distribute rebates off-chain if needed).
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        require(IERC20(token).transfer(to, amount), "transfer failed");
        emit Swept(token, to, amount);
    }
}