// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

error LOCK_ACTIVE();

contract MockLPPPositionManager {
    bool public conservativeMode;
    uint256 public lastTokenId;
    mapping(uint256 => uint256) public lockUntilByToken;

    event PositionLocked(uint256 indexed tokenId, uint256 lockUntil);

    function setConservativeMode(bool enabled) external {
        conservativeMode = enabled;
    }

    // Called by the hook; we pretend a fresh position tokenId per mint.
    function lockFromHook(uint32 secs) external {
        uint256 tokenId = ++lastTokenId;
        uint256 dur = uint256(secs) * (conservativeMode ? 2 : 1);
        uint256 until = block.timestamp + dur;
        lockUntilByToken[tokenId] = until;
        emit PositionLocked(tokenId, until);
    }

function decreaseLiquidity(uint256 tokenId) external view {
    if (block.timestamp < lockUntilByToken[tokenId]) revert LOCK_ACTIVE();
        // no-op
    }
}