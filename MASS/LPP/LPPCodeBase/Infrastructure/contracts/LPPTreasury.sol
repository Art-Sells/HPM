// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPTreasury } from "./interfaces/ILPPTreasury.sol";

contract LPPTreasury is ILPPTreasury {
    address public owner;
    address public override assetRetentionReceiver;
    address public override usdcRetentionReceiver;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RetentionReceiversSet(address assetReceiver, address usdcReceiver);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _assetReceiver, address _usdcReceiver) {
        owner = msg.sender;
        assetRetentionReceiver = _assetReceiver;
        usdcRetentionReceiver  = _usdcReceiver;
        emit OwnershipTransferred(address(0), msg.sender);
        emit RetentionReceiversSet(_assetReceiver, _usdcReceiver);
    }

    function setRetentionReceivers(address _assetReceiver, address _usdcReceiver) external onlyOwner {
        assetRetentionReceiver = _assetReceiver;
        usdcRetentionReceiver  = _usdcReceiver;
        emit RetentionReceiversSet(_assetReceiver, _usdcReceiver);
    }
}
