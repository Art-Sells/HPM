// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.7.6;
pragma abicoder v2;

import '@lpp/lpp-protocol/contracts/interfaces/ILPPPool.sol';
import '@lpp/lpp-protocol/contracts/libraries/FixedPoint128.sol';
import '@lpp/lpp-protocol/contracts/libraries/FullMath.sol';

import './interfaces/INonfungiblePositionManager.sol';
import './interfaces/IHookEntrypoints.sol';
import './interfaces/IHookMint.sol';
import './interfaces/INonfungibleTokenPositionDescriptor.sol';

import './libraries/PositionKey.sol';
import './libraries/PoolAddress.sol';

import './base/LiquidityManagement.sol';
import './base/PeripheryImmutableState.sol';
import './base/Multicall.sol';
import './base/ERC721Permit.sol';
import './base/PeripheryValidation.sol';
import './base/SelfPermit.sol';
import './base/PoolInitializer.sol';

/// @dev Minimal factory interface (replace with your concrete one if you have it)
interface ILPPFactoryMinimal {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @title NFT positions (hook-gated)
/// @notice Wraps positions in the ERC721 interface; all pool.mint flows are executed by the pool’s configured hook.
contract NonfungiblePositionManager is
    INonfungiblePositionManager,
    IHookEntrypoints,
    Multicall,
    ERC721Permit,
    PeripheryImmutableState,
    PoolInitializer,
    LiquidityManagement,
    PeripheryValidation,
    SelfPermit
{
    // ─────────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────────

    struct Position {
        uint96 nonce;
        address operator;
        uint80 poolId;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    /// @dev IDs of pools assigned by this contract
    mapping(address => uint80) private _poolIds;

    /// @dev Pool keys by pool ID, to save on SSTOREs for position data
    mapping(uint80 => PoolAddress.PoolKey) private _poolIdToPoolKey;

    /// @dev The token ID position data
    mapping(uint256 => Position) private _positions;

    /// @dev The ID of the next token that will be minted. Skips 0
    uint176 private _nextId = 1;
    /// @dev The ID of the next pool that is used for the first time. Skips 0
    uint80 private _nextPoolId = 1;

    /// @dev The address of the token descriptor contract, which handles generating token URIs for position tokens
    address private immutable _tokenDescriptor;

    /// @dev Pending context for a hook-driven mint/increase call
    struct PendingMintCtx {
        bool active;
        address pool;
        address payer; // who funds owed tokens (ERC20 approvals) or provides ETH for WETH9
        address token0;
        address token1;
        uint24 fee;
        address recipient; // only used for fresh mints
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Min;
        uint256 amount1Min;
    }
    PendingMintCtx private _pending;

    /// @dev Temp result for mint() to return after finalizeMintFromHook()
    struct PendingMintResult {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0;
        uint256 amount1;
    }
    PendingMintResult private _mintResult;

    /// @dev Temp result for increaseLiquidity() to return after finalizeIncreaseFromHook()
    struct PendingIncreaseResult {
        uint128 addedLiquidity;
        uint256 amount0;
        uint256 amount1;
    }
    PendingIncreaseResult private _incResult;

    // ─────────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────────

    constructor(
        address _factory,
        address _WETH9,
        address _tokenDescriptor_
    ) ERC721Permit('Positions NFT-V1', 'LPP-POS', '1') PeripheryImmutableState(_factory, _WETH9) {
        _tokenDescriptor = _tokenDescriptor_;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc INonfungiblePositionManager
    function positions(uint256 tokenId)
        external
        view
        override
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Position memory position = _positions[tokenId];
        require(position.poolId != 0, 'Invalid token ID');
        PoolAddress.PoolKey memory poolKey = _poolIdToPoolKey[position.poolId];
        return (
            position.nonce,
            position.operator,
            poolKey.token0,
            poolKey.token1,
            poolKey.fee,
            position.tickLower,
            position.tickUpper,
            position.liquidity,
            position.feeGrowthInside0LastX128,
            position.feeGrowthInside1LastX128,
            position.tokensOwed0,
            position.tokensOwed1
        );
    }

    function tokenURI(uint256 tokenId) public view override(ERC721, IERC721Metadata) returns (string memory) {
        require(_exists(tokenId));
        return INonfungibleTokenPositionDescriptor(_tokenDescriptor).tokenURI(this, tokenId);
    }

    // save bytecode by removing implementation of unused method
    function baseURI() public pure override returns (string memory) { return ""; }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internal helpers (hook resolution / pool key cache / pool resolution)
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Resolve the pool’s configured mint hook via staticcall to `mintHook()`
    function _isContract(address a) private view returns (bool) {
        uint256 size;
        assembly { size := extcodesize(a) } // solhint-disable-line no-inline-assembly
        return size > 0;
    }

    /// @dev Try to resolve a mint hook on the pool; returns address(0) if none.
// ===== PATCH 1: replace your _getHook with this robust version =====
function _getHook(address pool) internal view returns (address h) {
    if (pool == address(0)) return address(0);

    bool ok; bytes memory data;

    // 1) mintHook()
    (ok, data) = pool.staticcall(abi.encodeWithSignature("mintHook()"));
    if (ok && data.length >= 32) {
        assembly { h := mload(add(data, 32)) }
        if (h != address(0) && _isContract(h)) return h;
    }

    // 2) hook()
    h = address(0);
    (ok, data) = pool.staticcall(abi.encodeWithSignature("hook()"));
    if (ok && data.length >= 32) {
        assembly { h := mload(add(data, 32)) }
        if (h != address(0) && _isContract(h)) return h;
    }

    // 3) getHook()
    h = address(0);
    (ok, data) = pool.staticcall(abi.encodeWithSignature("getHook()"));
    if (ok && data.length >= 32) {
        assembly { h := mload(add(data, 32)) }
        if (h != address(0) && _isContract(h)) return h;
    }

    // 4) hookConfig() -> (address mintHook, ...)
    h = address(0);
    (ok, data) = pool.staticcall(abi.encodeWithSignature("hookConfig()"));
    if (ok && data.length >= 32) {
        assembly { h := mload(add(data, 32)) }
        if (h != address(0) && _isContract(h)) return h;
    }

    // 5) factory-level helper (best-effort): getHook(address pool)
    h = address(0);
    (ok, data) = factory.staticcall(abi.encodeWithSignature("getHook(address)", pool));
    if (ok && data.length >= 32) {
        assembly { h := mload(add(data, 32)) }
        if (h != address(0) && _isContract(h)) return h;
    }

    return address(0);
}

    function _onlyPoolHook(address pool) internal view {
        require(msg.sender == _getHook(pool), "ONLY_MINT_HOOK");
    }

    /// @dev Caches a pool key
    function cachePoolKey(address pool, PoolAddress.PoolKey memory poolKey) private returns (uint80 poolId) {
        poolId = _poolIds[pool];
        if (poolId == 0) {
            _poolIds[pool] = (poolId = _nextPoolId++);
            _poolIdToPoolKey[poolId] = poolKey;
        }
    }

    /// @dev Resolve the pool address from the factory and ensure code exists.
    function _resolvePoolAddress(PoolAddress.PoolKey memory key) internal view returns (address p) {
        p = ILPPFactoryMinimal(factory).getPool(key.token0, key.token1, key.fee);
        require(p != address(0), "LPP: pool not deployed");
        uint256 size;
        assembly { size := extcodesize(p) }
        require(size > 0, "LPP: pool code missing");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Hook entrypoints (called by the pool’s configured hook)
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IHookEntrypoints
    function hookPay(address pool, address token, uint256 amount) external override {
        _onlyPoolHook(pool);
        if (amount == 0) return;

        // Ensure we are in the middle of a pending flow for this pool
        require(_pending.active && _pending.pool == pool, "NO_PENDING");

        // If paying WETH9 and we have ETH balance, prefer using ETH path (deposit then transfer)
        if (token == WETH9 && address(this).balance >= amount) {
            pay(token, address(this), pool, amount);
        } else {
            // Otherwise pull from the original payer (must have approved this manager)
            address payer = _pending.payer;
            if (payer == address(0)) payer = address(this);
            pay(token, payer, pool, amount);
        }
    }

    /// @inheritdoc IHookEntrypoints
    function finalizeMintFromHook(
        address pool,
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    ) external override returns (uint256 tokenId) {
        _onlyPoolHook(pool);
        require(_pending.active && _pending.pool == pool, "NO_PENDING");
        require(_pending.recipient == recipient, "CTX_RECIP");
        require(_pending.tickLower == tickLower && _pending.tickUpper == tickUpper, "CTX_TICKS");
        require(amount0 >= _pending.amount0Min && amount1 >= _pending.amount1Min, "SLIPPAGE");

        // Mint the NFT
        _mint(recipient, (tokenId = _nextId++));

        // Cache pool key and snapshot fee growth
        uint80 poolId = cachePoolKey(
            pool,
            PoolAddress.PoolKey({ token0: _pending.token0, token1: _pending.token1, fee: _pending.fee })
        );

        bytes32 positionKey = PositionKey.compute(address(this), tickLower, tickUpper);
        (, uint256 fee0, uint256 fee1, , ) = ILPPPool(pool).positions(positionKey);

        _positions[tokenId] = Position({
            nonce: 0,
            operator: address(0),
            poolId: poolId,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            feeGrowthInside0LastX128: fee0,
            feeGrowthInside1LastX128: fee1,
            tokensOwed0: 0,
            tokensOwed1: 0
        });

        // Prepare return payload for mint()
        _mintResult = PendingMintResult({
            tokenId: tokenId,
            liquidity: liquidity,
            amount0: amount0,
            amount1: amount1
        });

        _pending.active = false;

        emit IncreaseLiquidity(tokenId, liquidity, amount0, amount1);
    }

    /// @inheritdoc IHookEntrypoints
    function finalizeIncreaseFromHook(
        address pool,
        uint256 tokenId,
        int24 tickLower,
        int24 tickUpper,
        uint128 addedLiquidity,
        uint256 amount0,
        uint256 amount1
    ) external override {
        _onlyPoolHook(pool);
        require(_pending.active && _pending.pool == pool, "NO_PENDING");

        Position storage position = _positions[tokenId];
        require(position.poolId != 0, "Invalid token ID");
        require(position.tickLower == tickLower && position.tickUpper == tickUpper, "CTX_TICKS");

        // Snapshot fee growth and accrue fees on prior liquidity
        bytes32 positionKey = PositionKey.compute(address(this), position.tickLower, position.tickUpper);
        (, uint256 fee0, uint256 fee1, , ) = ILPPPool(pool).positions(positionKey);

        position.tokensOwed0 += uint128(FullMath.mulDiv(
            fee0 - position.feeGrowthInside0LastX128,
            position.liquidity,
            FixedPoint128.Q128
        ));
        position.tokensOwed1 += uint128(FullMath.mulDiv(
            fee1 - position.feeGrowthInside1LastX128,
            position.liquidity,
            FixedPoint128.Q128
        ));

        position.feeGrowthInside0LastX128 = fee0;
        position.feeGrowthInside1LastX128 = fee1;
        position.liquidity += addedLiquidity;

        _incResult = PendingIncreaseResult({
            addedLiquidity: addedLiquidity,
            amount0: amount0,
            amount1: amount1
        });

        _pending.active = false;

        emit IncreaseLiquidity(tokenId, addedLiquidity, amount0, amount1);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internal: legacy (no-hook) paths to reduce stack pressure
    // ─────────────────────────────────────────────────────────────────────────────

    function _legacyMintPath(
        MintParams calldata params,
        PoolAddress.PoolKey memory key
    ) private returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        ILPPPool pool;
        {
            // scope to drop locals after the call
            AddLiquidityParams memory alp = AddLiquidityParams({
                token0: params.token0,
                token1: params.token1,
                fee:    params.fee,
                tickLower: params.tickLower,
                tickUpper: params.tickUpper,
                amount0Desired: params.amount0Desired,
                amount1Desired: params.amount1Desired,
                amount0Min: params.amount0Min,
                amount1Min: params.amount1Min,
                recipient: address(this)
            });
            (liquidity, amount0, amount1, pool) = addLiquidity(alp);
        }

        // Mint NFT to recipient and snapshot fee growth
        _mint(params.recipient, (tokenId = _nextId++));
        uint80 poolId = cachePoolKey(address(pool), key);

        bytes32 positionKey = PositionKey.compute(address(this), params.tickLower, params.tickUpper);
        (, uint256 fee0, uint256 fee1, , ) = pool.positions(positionKey);

        _positions[tokenId] = Position({
            nonce: 0,
            operator: address(0),
            poolId: poolId,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            feeGrowthInside0LastX128: fee0,
            feeGrowthInside1LastX128: fee1,
            tokensOwed0: 0,
            tokensOwed1: 0
        });

        emit IncreaseLiquidity(tokenId, liquidity, amount0, amount1);
    }

    function _legacyIncreasePath(
        IncreaseLiquidityParams calldata params,
        Position storage position,
        PoolAddress.PoolKey memory key,
        address poolAddr
    ) private returns (uint128 added, uint256 amount0, uint256 amount1)
    {
        // Accrue fees on current liquidity
        bytes32 pKey = PositionKey.compute(address(this), position.tickLower, position.tickUpper);
        (, uint256 fee0, uint256 fee1, , ) = ILPPPool(poolAddr).positions(pKey);

        position.tokensOwed0 += uint128(FullMath.mulDiv(
            fee0 - position.feeGrowthInside0LastX128,
            position.liquidity,
            FixedPoint128.Q128
        ));
        position.tokensOwed1 += uint128(FullMath.mulDiv(
            fee1 - position.feeGrowthInside1LastX128,
            position.liquidity,
            FixedPoint128.Q128
        ));

        position.feeGrowthInside0LastX128 = fee0;
        position.feeGrowthInside1LastX128 = fee1;

        {
            // scope to drop locals after the call
            AddLiquidityParams memory alp = AddLiquidityParams({
                token0: key.token0,
                token1: key.token1,
                fee:    key.fee,
                tickLower: position.tickLower,
                tickUpper: position.tickUpper,
                amount0Desired: params.amount0Desired,
                amount1Desired: params.amount1Desired,
                amount0Min: params.amount0Min,
                amount1Min: params.amount1Min,
                recipient: address(this)
            });

            (added, amount0, amount1, ) = addLiquidity(alp);
        }

        position.liquidity += added;
        emit IncreaseLiquidity(params.tokenId, added, amount0, amount1);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Public: mint / increase (hook-routed; pool resolved via factory)
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc INonfungiblePositionManager
    function mint(MintParams calldata params)
        external
        payable
        override
        checkDeadline(params.deadline)
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        require(!_pending.active, "PENDING");

        PoolAddress.PoolKey memory key = PoolAddress.PoolKey({
            token0: params.token0,
            token1: params.token1,
            fee:    params.fee
        });

        address poolAddr = PoolAddress.computeAddress(factory, key);
        address hook = _getHook(poolAddr);

        if (hook == address(0)) {
            // ── LEGACY (no hook): do a direct addLiquidity, then mint the NFT ──
            return _legacyMintPath(params, key);
        }

        // ── Hooked path ──
        _pending = PendingMintCtx({
            active: true,
            pool: poolAddr,
            payer: msg.sender,
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            recipient: params.recipient,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            amount0Min: params.amount0Min,
            amount1Min: params.amount1Min
        });

        IHookMint(hook).mintViaHook(IHookMint.MintViaHookParams({
            pool: poolAddr,
            payer: msg.sender,
            recipient: params.recipient,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            amount0Desired: params.amount0Desired,
            amount1Desired: params.amount1Desired
        }));

        tokenId   = _mintResult.tokenId;
        liquidity = _mintResult.liquidity;
        amount0   = _mintResult.amount0;
        amount1   = _mintResult.amount1;

        delete _mintResult;
    }

    /// @inheritdoc INonfungiblePositionManager
    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        override
        checkDeadline(params.deadline)
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        require(!_pending.active, "PENDING");

        Position storage position = _positions[params.tokenId];
        require(position.poolId != 0, "Invalid token ID");

        PoolAddress.PoolKey memory key = _poolIdToPoolKey[position.poolId];
        address poolAddr = PoolAddress.computeAddress(factory, key);
        address hook = _getHook(poolAddr);

        if (hook == address(0)) {
            // ── LEGACY (no hook): accrue fees on current liquidity, then add ──
            (liquidity, amount0, amount1) = _legacyIncreasePath(params, position, key, poolAddr);
            return (liquidity, amount0, amount1);
        }

        // ── Hooked path ──
        _pending = PendingMintCtx({
            active: true,
            pool: poolAddr,
            payer: msg.sender,
            token0: key.token0,
            token1: key.token1,
            fee: key.fee,
            recipient: address(0),
            tickLower: position.tickLower,
            tickUpper: position.tickUpper,
            amount0Min: params.amount0Min,
            amount1Min: params.amount1Min
        });

        IHookMint(hook).increaseViaHook(IHookMint.IncreaseViaHookParams({
            pool: poolAddr,
            payer: msg.sender,
            tokenId: params.tokenId,
            tickLower: position.tickLower,
            tickUpper: position.tickUpper,
            amount0Desired: params.amount0Desired,
            amount1Desired: params.amount1Desired
        }));

        liquidity = _incResult.addedLiquidity;
        amount0   = _incResult.amount0;
        amount1   = _incResult.amount1;

        delete _incResult;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Public: decrease / collect / burn (pool resolved via factory)
    // ─────────────────────────────────────────────────────────────────────────────

    modifier isAuthorizedForToken(uint256 tokenId) {
        require(_isApprovedOrOwner(msg.sender, tokenId), 'Not approved');
        _;
    }

    /// @inheritdoc INonfungiblePositionManager
    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        override
        isAuthorizedForToken(params.tokenId)
        checkDeadline(params.deadline)
        returns (uint256 amount0, uint256 amount1)
    {
        require(params.liquidity > 0);
        Position storage position = _positions[params.tokenId];

        uint128 positionLiquidity = position.liquidity;
        require(positionLiquidity >= params.liquidity);

        PoolAddress.PoolKey memory poolKey = _poolIdToPoolKey[position.poolId];
        ILPPPool pool = ILPPPool(_resolvePoolAddress(poolKey));
        (amount0, amount1) = pool.burn(position.tickLower, position.tickUpper, params.liquidity);

        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, 'Price slippage check');

        bytes32 positionKey = PositionKey.compute(address(this), position.tickLower, position.tickUpper);
        (, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, , ) = pool.positions(positionKey);

        position.tokensOwed0 +=
            uint128(amount0) +
            uint128(FullMath.mulDiv(
                feeGrowthInside0LastX128 - position.feeGrowthInside0LastX128,
                positionLiquidity,
                FixedPoint128.Q128
            ));
        position.tokensOwed1 +=
            uint128(amount1) +
            uint128(FullMath.mulDiv(
                feeGrowthInside1LastX128 - position.feeGrowthInside1LastX128,
                positionLiquidity,
                FixedPoint128.Q128
            ));

        position.feeGrowthInside0LastX128 = feeGrowthInside0LastX128;
        position.feeGrowthInside1LastX128 = feeGrowthInside1LastX128;
        position.liquidity = positionLiquidity - params.liquidity;

        emit DecreaseLiquidity(params.tokenId, params.liquidity, amount0, amount1);
    }

    /// @inheritdoc INonfungiblePositionManager
    function collect(CollectParams calldata params)
        external
        payable
        override
        isAuthorizedForToken(params.tokenId)
        returns (uint256 amount0, uint256 amount1)
    {
        require(params.amount0Max > 0 || params.amount1Max > 0);
        address recipient = params.recipient == address(0) ? address(this) : params.recipient;

        Position storage position = _positions[params.tokenId];
        PoolAddress.PoolKey memory poolKey = _poolIdToPoolKey[position.poolId];
        ILPPPool pool = ILPPPool(_resolvePoolAddress(poolKey));

        (uint128 tokensOwed0, uint128 tokensOwed1) = (position.tokensOwed0, position.tokensOwed1);

        if (position.liquidity > 0) {
            pool.burn(position.tickLower, position.tickUpper, 0);
            (, uint256 fee0, uint256 fee1, , ) =
                pool.positions(PositionKey.compute(address(this), position.tickLower, position.tickUpper));

            tokensOwed0 += uint128(FullMath.mulDiv(
                fee0 - position.feeGrowthInside0LastX128,
                position.liquidity,
                FixedPoint128.Q128
            ));
            tokensOwed1 += uint128(FullMath.mulDiv(
                fee1 - position.feeGrowthInside1LastX128,
                position.liquidity,
                FixedPoint128.Q128
            ));

            position.feeGrowthInside0LastX128 = fee0;
            position.feeGrowthInside1LastX128 = fee1;
        }

        (uint128 amount0Collect, uint128 amount1Collect) =
            (
                params.amount0Max > tokensOwed0 ? tokensOwed0 : params.amount0Max,
                params.amount1Max > tokensOwed1 ? tokensOwed1 : params.amount1Max
            );

        (amount0, amount1) = pool.collect(
            recipient,
            position.tickLower,
            position.tickUpper,
            amount0Collect,
            amount1Collect
        );

        (position.tokensOwed0, position.tokensOwed1) = (tokensOwed0 - amount0Collect, tokensOwed1 - amount1Collect);

        emit Collect(params.tokenId, recipient, amount0Collect, amount1Collect);
    }

    /// @inheritdoc INonfungiblePositionManager
    function burn(uint256 tokenId) external payable override isAuthorizedForToken(tokenId) {
        Position storage position = _positions[tokenId];
        require(position.liquidity == 0 && position.tokensOwed0 == 0 && position.tokensOwed1 == 0, 'Not cleared');
        delete _positions[tokenId];
        _burn(tokenId);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // ERC721 permit plumbing
    // ─────────────────────────────────────────────────────────────────────────────

    function _getAndIncrementNonce(uint256 tokenId) internal override returns (uint256) {
        return uint256(_positions[tokenId].nonce++);
    }

    /// @inheritdoc IERC721
    function getApproved(uint256 tokenId) public view override(ERC721, IERC721) returns (address) {
        require(_exists(tokenId), 'ERC721: approved query for nonexistent token');
        return _positions[tokenId].operator;
    }

    function _approve(address to, uint256 tokenId) internal override(ERC721) {
        _positions[tokenId].operator = to;
        emit Approval(ownerOf(tokenId), to, tokenId);
    }
}