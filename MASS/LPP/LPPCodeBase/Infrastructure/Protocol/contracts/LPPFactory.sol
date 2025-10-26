// contracts/LPPFactory.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.7.6;

import "./interfaces/ILPPFactory.sol";
import "./LPPPoolDeployer.sol";
import "./NoDelegateCall.sol";
import "./LPPPool.sol";

contract LPPFactory is ILPPFactory, LPPPoolDeployer, NoDelegateCall {
    address public override owner;
    mapping(uint24 => int24) public override feeAmountTickSpacing;
    mapping(address => mapping(address => mapping(uint24 => address))) public override getPool;

    // lock the hook for all pools from this factory
    address public immutable mintHook;

    // **FIX**: accept the hook in the constructor
    constructor(address _mintHook) {
        require(_mintHook != address(0), "HOOK=0");
        owner = msg.sender;
        mintHook = _mintHook;
        emit OwnerChanged(address(0), msg.sender);
    }

    function createPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external override noDelegateCall returns (address pool) {
        require(tokenA != tokenB, "IDENTICAL");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "ZERO_ADDR");
        require(fee == 0, "FEE_NOT_ZERO");

        int24 tickSpacing = feeAmountTickSpacing[fee];
        require(tickSpacing != 0, "FEE_NOT_ENABLED");
        require(getPool[token0][token1][fee] == address(0), "EXISTS");

        // pass the locked-in hook down to the deployer
        pool = deploy(address(this), token0, token1, fee, tickSpacing, mintHook);

        getPool[token0][token1][fee] = pool;
        getPool[token1][token0][fee] = pool;

        emit PoolCreated(token0, token1, fee, tickSpacing, pool);
    }

    function setOwner(address _owner) external override {
        require(msg.sender == owner, "NOT_OWNER");
        emit OwnerChanged(owner, _owner);
        owner = _owner;
    }

    function enableFeeAmount(uint24 fee, int24 tickSpacing) public override {
        require(msg.sender == owner, "NOT_OWNER");
        require(fee == 0, "FEE_NOT_ZERO");
        require(tickSpacing > 0 && tickSpacing < 16384, "BAD_TICK_SPACING");
        require(feeAmountTickSpacing[fee] == 0, "ALREADY_ENABLED");
        feeAmountTickSpacing[fee] = tickSpacing;
        emit FeeAmountEnabled(fee, tickSpacing);
    }
}