// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFAFEAccessManager {
    event SupplicatorApproved(address indexed who, bool approved);

    function setApprovedSupplicator(address who, bool approved) external;
    function isApprovedSupplicator(address who) external view returns (bool);
}
