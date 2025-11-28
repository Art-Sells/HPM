// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IFAFEAccessManager } from "./interfaces/IFAFEAccessManager.sol";

contract FAFEAccessManager is IFAFEAccessManager {
    address public owner;
    address public treasury; // Treasury address (set once by owner)
    mapping(address => bool) private _approved;
    address public override dedicatedAA; // Dedicated AA address for swap operations

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyTreasury() { require(msg.sender == treasury && treasury != address(0), "not treasury"); _; }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setApprovedSupplicator(address who, bool approved) external override onlyOwner {
        require(who != address(0), "zero address");
        _approved[who] = approved;
        emit SupplicatorApproved(who, approved);
    }

    function isApprovedSupplicator(address who) external view override returns (bool) {
        return _approved[who];
    }

    /// @notice Set the treasury address (only callable by owner, can only be set once)
    /// @param treasury_ The treasury contract address
    function setTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "zero treasury");
        require(treasury == address(0), "treasury already set");
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @notice Set the dedicated AA address (only callable by treasury)
    /// @param aaAddress The address that will be the only one allowed to call swap()
    function setDedicatedAA(address aaAddress) external override onlyTreasury {
        require(aaAddress != address(0), "zero address");
        address previousAA = dedicatedAA;
        dedicatedAA = aaAddress;
        emit DedicatedAASet(previousAA, aaAddress);
    }

    /// @notice Check if an address is the dedicated AA
    function isDedicatedAA(address who) external view override returns (bool) {
        return who == dedicatedAA && dedicatedAA != address(0);
    }
}
