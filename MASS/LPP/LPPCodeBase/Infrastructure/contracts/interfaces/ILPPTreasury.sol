// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPTreasury {

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
    // Router forwarder (needed for orbit tests)
    // -----------------------------------------------------------------------
    function setOrbitViaTreasury(
        address router,
        address startPool,
        address[] calldata pools
    ) external;

    function setDualOrbitViaTreasury(
        address router,
        address startPool,
        address[] calldata neg,
        address[] calldata pos,
        bool startWithNeg
    ) external;

    function setDailyEventCapViaTreasury(address router, uint16 newCap) external;

    function pauseRouterViaTreasury(address router) external;
    function unpauseRouterViaTreasury(address router) external;

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