// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}

/**
 * @title LPPTreasury
 * @notice Minimal custody contract for retention. Ownable (two-step), sweep ERC20/ETH.
 *         Set the owner to your Safe in the constructor.
 */
contract LPPTreasury {
    address public owner;
    address public pendingOwner;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Swept(address indexed token, address indexed to, uint256 amount);
    event SweptETH(address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _owner) {
        require(_owner != address(0), "owner=0");
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    // --- Ownership (two-step) ---

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "newOwner=0");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending");
        address old = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(old, owner);
    }

    // --- Sweeps ---

    function sweepERC20(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "to=0");
        require(IERC20(token).transfer(to, amount), "transfer failed");
        emit Swept(token, to, amount);
    }

    function sweepAllERC20(address token, address to) external onlyOwner {
        require(to != address(0), "to=0");
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(IERC20(token).transfer(to, bal), "transfer failed");
        emit Swept(token, to, bal);
    }

    receive() external payable {}

    function sweepETH(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "to=0");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "eth xfer failed");
        emit SweptETH(to, amount);
    }
}