// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPAccessManager } from "./interfaces/ILPPAccessManager.sol";

contract LPPAccessManager is ILPPAccessManager {
    address public owner;
    mapping(address => bool) private _approved;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

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
}
