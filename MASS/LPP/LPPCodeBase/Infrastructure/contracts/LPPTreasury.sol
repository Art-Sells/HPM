// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPTreasury } from "./interfaces/ILPPTreasury.sol";
import { ILPPFactory }  from "./interfaces/ILPPFactory.sol";

/// Minimal hook interface to forward bootstrap calls with optional price offset
interface ILPPMintHookMinimal {
    function bootstrap(address pool, uint256 amtA, uint256 amtU, int256 offsetBps) external;
}

contract LPPTreasury is ILPPTreasury {
    address public override owner;
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

    // ─────────────────────────────────────────────────────────────
    // Factory forwarders (this contract address must equal Factory.treasury)
    // ─────────────────────────────────────────────────────────────

    function createPoolViaTreasury(address factory, address asset, address usdc)
        external
        onlyOwner
        returns (address pool)
    {
        pool = ILPPFactory(factory).createPool(asset, usdc);
    }

    function setPoolHookViaTreasury(address factory, address pool, address hook)
        external
        onlyOwner
    {
        ILPPFactory(factory).setPoolHook(pool, hook);
    }

    /// Forward allow-listing to Factory (Factory requires onlyTreasury)
    function allowTokenViaTreasury(address factory, address token, bool allowed)
        external
        onlyOwner
    {
        ILPPFactory(factory).setAllowedToken(token, allowed);
    }

    /// Bootstrap via hook (offset in bps; can pass 0)
    function bootstrapViaTreasury(
        address hook,
        address pool,
        uint256 amountAsset,
        uint256 amountUsdc,
        int256 offsetBps
    )
        external
        onlyOwner
    {
        ILPPMintHookMinimal(hook).bootstrap(pool, amountAsset, amountUsdc, offsetBps);
    }

    /// Back-compat overload (offset = 0)
    function bootstrapViaTreasury(
        address hook,
        address pool,
        uint256 amountAsset,
        uint256 amountUsdc
    )
        external
        onlyOwner
    {
        ILPPMintHookMinimal(hook).bootstrap(pool, amountAsset, amountUsdc, 0);
    }

    /// Rotate Factory.treasury to a new address
    function rotateFactoryTreasury(address factory, address newTreasury)
        external
        onlyOwner
    {
        ILPPFactory(factory).setTreasury(newTreasury);
    }

    // optional: owner transfer helper
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}