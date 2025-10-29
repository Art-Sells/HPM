// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.20;

import "./interfaces/ILPPPool.sol";
import "./utils/Ownable.sol";

contract LPPPositionManager is Ownable {
    error LOCK_ACTIVE();
    error NOT_HOOK();
    event ConservativeModeSet(bool enabled);
    event LockScheduleUpdated(uint32[4] lockSecs);
    event PositionLocked(uint256 indexed tokenId, uint8 indexed tier, uint64 lockUntil);

    address public immutable mintHook;     // canonical hook allowed to finalize
    bool    public conservativeMode;       // doubles all locks
    uint32[4] public baseLockSecs;         // default: [6h, 1d, 3d, 7d]

    mapping(uint256 => uint64) public lockUntil;

    constructor(address _hook, uint32[4] memory _base) {
        mintHook = _hook;
        baseLockSecs = _base;
    }

    modifier onlyHook() {
        if (msg.sender != mintHook) revert NOT_HOOK();
        _;
    }

    function setConservativeMode(bool on) external onlyOwner {
        conservativeMode = on;
        emit ConservativeModeSet(on);
    }

    function setBaseLockSecs(uint32[4] calldata secs) external onlyOwner {
        baseLockSecs = secs;
        emit LockScheduleUpdated(secs);
    }

    // called *only* by the hook after it settled the surcharge
    function finalizeMintFromHook(
        address pool,
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint8 tier,
        uint32 hookSuggestedLockSecs
    ) external onlyHook returns (uint256 tokenId) {
        // mint the position (as in your current flow)
        tokenId = _mintPosition(pool, recipient, tickLower, tickUpper, liquidity);

        uint32 base = hookSuggestedLockSecs; // or baseLockSecs[tier] if you want manager to own it
        uint64 until = uint64(block.timestamp) + (conservativeMode ? base * 2 : base);
        lockUntil[tokenId] = until;
        emit PositionLocked(tokenId, tier, until);
    }

    // Example gate on your decrease/burn path
    function decreaseLiquidity(/* params incl tokenId */) external {
        uint256 tokenId = /* read from params */;
        if (block.timestamp < lockUntil[tokenId]) revert LOCK_ACTIVE();
        _decrease(/* ... */);
    }

    // --- internal stubs bound to your existing NFPM / Router ---
    function _mintPosition(address pool, address recipient, int24 a, int24 b, uint128 L)
        internal returns (uint256 tokenId) { /* your existing mint path */ }

    function _decrease(/*...*/) internal { /* your existing burn/decrease path */ }
}