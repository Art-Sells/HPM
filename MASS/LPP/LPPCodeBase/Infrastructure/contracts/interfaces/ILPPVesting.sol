// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILPPVesting {
    /* ========= Read ========= */

    function treasury() external view returns (address);
    function vault() external view returns (address);

    function epochSeconds() external view returns (uint256);
    function startTime() external view returns (uint256);
    function currentEpoch() external view returns (uint256);

    function scheduleLength() external view returns (uint256);
    function schedule(uint256 i) external view returns (uint256);
    function getSchedule() external view returns (uint256[] memory);

    function grants(address beneficiary, address token) external view returns (uint256);
    function claimed(address beneficiary, address token) external view returns (uint256);

    /// Total vested so far (in token units) and the currently claimable (vested - claimed).
    function vestedOf(address beneficiary, address token) external view returns (uint256);
    function claimableOf(address beneficiary, address token) external view returns (uint256);

    /* ========= Write: grants & claims ========= */

    /// Record or increase a grant for a beneficiary in a specific token.
    /// Access control is deliberately open here so tests can focus on epoch/schedule rules.
    /// Gate this in production if needed.
    function grant(address beneficiary, address token, uint256 amount) external;

    /// Claim all claimable amounts across all granted tokens for msg.sender.
    function claim() external;

    /// Claim only the portion that became vested by/before a specific epoch index (inclusive).
    /// If epoch >= currentEpoch(), behaves like claim().
    function claim(uint256 epoch) external;

    /// Claim on behalf of a beneficiary across all their tokens.
    function claimFor(address beneficiary) external;

    /// Claim on behalf of a beneficiary up to a specific epoch.
    function claimFor(address beneficiary, uint256 epoch) external;

    /* ========= Admin: only Treasury can mutate epoch/schedule ========= */

    function setEpochSeconds(uint256 newEpochSeconds) external;
    function setStartTime(uint256 newStartTime) external;

    /// Replace the entire schedule (array of BPS that must sum to <= 10000).
    function setSchedule(uint256[] calldata newScheduleBps) external;

    /// Update a single entry at index.
    function setScheduleAt(uint256 index, uint256 bps) external;

    /// Append new entries to the end.
    function addScheduleTail(uint256[] calldata tailBps) external;

    /// Clear the schedule entirely (careful!); typically followed by setSchedule.
    function clearSchedule() external;
}