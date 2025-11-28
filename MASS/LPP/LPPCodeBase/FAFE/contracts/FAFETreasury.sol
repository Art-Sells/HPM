// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IFAFETreasury } from "./interfaces/IFAFETreasury.sol";
import { IFAFEFactory }  from "./interfaces/IFAFEFactory.sol";
import { IFAFEPool }     from "./interfaces/IFAFEPool.sol";
import { IFAFERouter }   from "./interfaces/IFAFERouter.sol";
import { IFAFEAccessManager } from "./interfaces/IFAFEAccessManager.sol";
import { IERC20 }       from "./external/IERC20.sol";

contract FAFETreasury is IFAFETreasury {
    address public override owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    // simple nonReentrant guard for withdrawals
    uint256 private _locked;
    modifier nonReentrant() {
        require(_locked == 0, "reentrancy");
        _locked = 1;
        _;
        _locked = 0;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // -----------------------------------------------------------------------
    // Ownership
    // -----------------------------------------------------------------------
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // -----------------------------------------------------------------------
    // Owner-controlled withdrawals
    // -----------------------------------------------------------------------
    /// @notice Withdraw ERC20 held by this treasury to `to`
    function withdrawERC20(address token, address to, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        require(to != address(0), "zero to");
        require(amount > 0, "zero amount");
        require(IERC20(token).balanceOf(address(this)) >= amount, "insufficient");
        require(IERC20(token).transfer(to, amount), "transfer fail");
    }

    // -----------------------------------------------------------------------
    // Factory forwarders (this contract address must equal Factory.treasury)
    // -----------------------------------------------------------------------
    function createPoolViaTreasury(address factory, address asset, address usdc)
        external
        onlyOwner
        returns (address pool)
    {
        pool = IFAFEFactory(factory).createPool(asset, usdc);
    }

    /// Forward allow-listing to Factory (Factory requires onlyTreasury)
    function allowTokenViaTreasury(address factory, address token, bool allowed)
        external
        onlyOwner
    {
        IFAFEFactory(factory).setAllowedToken(token, allowed);
    }

    /// Rotate Factory.treasury to a new address
    function rotateFactoryTreasury(address factory, address newTreasury)
        external
        onlyOwner
    {
        IFAFEFactory(factory).setTreasury(newTreasury);
    }

    // -----------------------------------------------------------------------
    // Router forwarders (Router requires onlyTreasury)
    // -----------------------------------------------------------------------

    /// @notice Pause the router (swaps, supplications, etc.)
    /// Calls Router.pause() as the Treasury contract so it passes Router's onlyTreasury check.
    function pauseRouterViaTreasury(address router) external onlyOwner {
        IFAFERouter(router).pause();
    }

    /// @notice Unpause the router
    /// Calls Router.unpause() as the Treasury contract so it passes Router's onlyTreasury check.
    function unpauseRouterViaTreasury(address router) external onlyOwner {
        IFAFERouter(router).unpause();
    }

    // -----------------------------------------------------------------------
    // Access Manager forwarders (for setting dedicated AA)
    // -----------------------------------------------------------------------

    /// @notice Set the dedicated AA address for swap operations
    /// Calls AccessManager.setDedicatedAA() as the Treasury contract
    function setDedicatedAAViaTreasury(address accessManager, address aaAddress) external onlyOwner {
        require(accessManager != address(0), "zero access");
        IFAFEAccessManager(accessManager).setDedicatedAA(aaAddress);
    }

    // -----------------------------------------------------------------------
    // Direct bootstrap (no MintHook, Phase 0)
    // -----------------------------------------------------------------------
    /// @notice Bootstrap a pool by sending ASSET + USDC from Treasury and initializing price with offset (bps).
    function bootstrapViaTreasury(
        address pool,
        uint256 amountAsset,
        uint256 amountUsdc,
        int256 offsetBps
    ) public onlyOwner {
        require(pool != address(0), "zero pool");
        require(amountAsset > 0 && amountUsdc > 0, "zero amount");

        address asset = IFAFEPool(pool).asset();
        address usdc  = IFAFEPool(pool).usdc();

        // Transfer tokens from Treasury to the Pool
        require(IERC20(asset).transfer(pool, amountAsset), "transfer asset fail");
        require(IERC20(usdc).transfer(pool, amountUsdc), "transfer usdc fail");

        // Initialize the pool with the provided amounts and offset
        IFAFEPool(pool).bootstrapInitialize(amountAsset, amountUsdc, offsetBps);
    }

    /// @notice Overload with offset = 0
    function bootstrapViaTreasury(
        address pool,
        uint256 amountAsset,
        uint256 amountUsdc
    ) external onlyOwner {
        // calls the public 4-arg version with offsetBps = 0
        bootstrapViaTreasury(pool, amountAsset, amountUsdc, 0);
    }

}