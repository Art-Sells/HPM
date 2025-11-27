// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFAFEAccessManager {
    event SupplicatorApproved(address indexed who, bool approved);
    event DedicatedAASet(address indexed previousAA, address indexed newAA);
    event TreasurySet(address indexed treasury);

    function setApprovedSupplicator(address who, bool approved) external;
    function isApprovedSupplicator(address who) external view returns (bool);
    
    // Treasury management
    function setTreasury(address treasury_) external;
    function treasury() external view returns (address);
    
    // Dedicated AA address for swap operations
    function setDedicatedAA(address aaAddress) external;
    function dedicatedAA() external view returns (address);
    function isDedicatedAA(address who) external view returns (bool);
}
