// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPTreasury } from "./interfaces/ILPPTreasury.sol";
import { ILPPFactory } from "./interfaces/ILPPFactory.sol";

/// Minimal hook interface so Treasury can forward bootstrap
interface ILPPMintHookMinimal {
    function bootstrap(address pool, uint256 amountAsset, uint256 amountUsdc) external;
}

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

    // ─────────────────────────────────────────────────────────────
    // Forwarders (this contract must be the Factory.treasury)
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

    function bootstrapViaTreasury(address hook, address pool, uint256 amountAsset, uint256 amountUsdc)
        external
        onlyOwner
    {
        ILPPMintHookMinimal(hook).bootstrap(pool, amountAsset, amountUsdc);
    }

    /// Rotate Factory governance to a new address (EOA/multisig/new Treasury).
    function rotateFactoryTreasury(address factory, address newTreasury)
        external
        onlyOwner
    {
        ILPPFactory(factory).setTreasury(newTreasury);
    }
}