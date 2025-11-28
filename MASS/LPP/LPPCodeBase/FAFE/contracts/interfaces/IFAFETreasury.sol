// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFAFETreasury {

    // -----------------------------------------------------------------------
    // View
    // -----------------------------------------------------------------------
    function owner() external view returns (address);

    // -----------------------------------------------------------------------
    // Factory forwarders
    // -----------------------------------------------------------------------
    function createPoolViaTreasury(
        address factory,
        address asset,
        address usdc
    ) external returns (address pool);

    function allowTokenViaTreasury(
        address factory,
        address token,
        bool allowed
    ) external;

    function rotateFactoryTreasury(
        address factory,
        address newTreasury
    ) external;

    // -----------------------------------------------------------------------
    // Router forwarder
    // -----------------------------------------------------------------------
    function pauseRouterViaTreasury(address router) external;
    function unpauseRouterViaTreasury(address router) external;
    
    // -----------------------------------------------------------------------
    // Access Manager forwarder (for setting dedicated AA)
    // -----------------------------------------------------------------------
    function setDedicatedAAViaTreasury(address accessManager, address aaAddress) external;

    // -----------------------------------------------------------------------
    // Bootstrap
    // -----------------------------------------------------------------------
    function bootstrapViaTreasury(
        address pool,
        uint256 amountAsset,
        uint256 amountUsdc,
        int256 offsetBps
    ) external;

    function bootstrapViaTreasury(
        address pool,
        uint256 amountAsset,
        uint256 amountUsdc
    ) external;

}