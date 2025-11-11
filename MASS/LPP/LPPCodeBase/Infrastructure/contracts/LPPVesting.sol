// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILPPVesting } from "./interfaces/ILPPVesting.sol";
import { IERC20 } from "./external/IERC20.sol";
import { SafeERC20 } from "./external/SafeERC20.sol";
using SafeERC20 for IERC20;

/**
 * @title LPPVesting
 * @notice Vesting engine with epoch-based percentage schedule (BPS) and Treasury-controlled mutability.
 *
 * - Vests in discrete epochs. An "epoch" is `epochSeconds` long starting from `startTime`.
 * - The schedule is an array of BPS slices (e.g., [2500,2500,2500,2500] == 25% x4); sum must be <= 10000.
 * - At epoch E (0-indexed) the vested percentage is the sum of schedule[0..E], capped at the schedule length.
 * - Claims are paid by pulling tokens from a designated `vault` via `transferFrom(vault, beneficiary, amount)`.
 *   → In tests, impersonate the vault and approve this contract for the relevant ERC20s.
 * - Treasury (immutable) can mutate `epochSeconds`, `startTime`, and the schedule.
 * - Anyone can `grant` (for tests). Gate it to Treasury in production if desired.
 */
contract LPPVesting is ILPPVesting {
    using SafeERC20 for IERC20;

    /* =======================================================
                                Storage
       ======================================================= */

    address public immutable override treasury;
    address public immutable override vault;

    uint256 public override epochSeconds;
    uint256 public override startTime;

    // BPS schedule
    uint256[] private _schedule; // each entry is BPS (out of 10000)

    // grants[beneficiary][token] = total granted
    mapping(address => mapping(address => uint256)) public override grants;

    // claimed[beneficiary][token] = total already claimed
    mapping(address => mapping(address => uint256)) public override claimed;

    // Keep track of which tokens a beneficiary has grants for (for all-token claims)
    mapping(address => address[]) private _beneficiaryTokens;
    mapping(address => mapping(address => bool)) private _seenTokenForBeneficiary;

    /* =======================================================
                               Events
       ======================================================= */

    event EpochSecondsUpdated(uint256 oldValue, uint256 newValue);
    event StartTimeUpdated(uint256 oldValue, uint256 newValue);
    event ScheduleReplaced(uint256[] newSchedule);
    event ScheduleEntryUpdated(uint256 index, uint256 oldBps, uint256 newBps);
    event ScheduleTailAdded(uint256[] tail);
    event ScheduleCleared();

    event Granted(address indexed beneficiary, address indexed token, uint256 amount);
    event Claimed(address indexed beneficiary, address indexed token, uint256 amount, uint256 effectiveEpoch);

    /* =======================================================
                              Errors
       ======================================================= */

    error NotTreasury();
    error ZeroAddress();
    error EpochZero();
    error ScheduleSumTooLarge();
    error NoGrants();

    /* =======================================================
                            Modifiers
       ======================================================= */

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert NotTreasury();
        _;
    }

    /* =======================================================
                           Construction
       ======================================================= */

    /// @param _treasury who can mutate epoch/schedule
    /// @param _vault    tokens are transferred FROM this address upon claim
    /// @param _epochSeconds seconds per epoch (must be > 0)
    /// @param _startTime    UNIX timestamp when epoch counting starts
    /// @param scheduleBps   BPS slices (sum <= 10000). If empty, defaults to 4×25%
    constructor(
        address _treasury,
        address _vault,
        uint256 _epochSeconds,
        uint256 _startTime,
        uint256[] memory scheduleBps
    ) {
        if (_treasury == address(0) || _vault == address(0)) revert ZeroAddress();
        if (_epochSeconds == 0) revert EpochZero();

        treasury = _treasury;
        vault = _vault;
        epochSeconds = _epochSeconds;
        startTime = _startTime;

        if (scheduleBps.length == 0) {
            _schedule.push(2500);
            _schedule.push(2500);
            _schedule.push(2500);
            _schedule.push(2500);
        } else {
            uint256 sum;
            for (uint256 i = 0; i < scheduleBps.length; i++) {
                _schedule.push(scheduleBps[i]);
                sum += scheduleBps[i];
            }
            if (sum > 10000) revert ScheduleSumTooLarge();
        }
    }

    /* =======================================================
                            Read API
       ======================================================= */

    function scheduleLength() external view override returns (uint256) {
        return _schedule.length;
    }

    function schedule(uint256 i) external view override returns (uint256) {
        if (i >= _schedule.length) return 0;
        return _schedule[i];
    }

    function getSchedule() external view override returns (uint256[] memory) {
        uint256 len = _schedule.length;
        uint256[] memory out = new uint256[](len);
        for (uint256 i = 0; i < len; i++) out[i] = _schedule[i];
        return out;
    }

    function currentEpoch() public view override returns (uint256) {
        if (block.timestamp <= startTime) return 0;
        // Epoch 0 is the first interval [startTime, startTime + epochSeconds)
        return (block.timestamp - startTime) / epochSeconds;
    }

    function _vestedBpsAtEpoch(uint256 epochIdx) internal view returns (uint256) {
        // vestedBps for completed epochs 0..epochIdx
        uint256 len = _schedule.length;
        if (len == 0) return 0;
        if (epochIdx + 1 > len) epochIdx = len - 1;

        uint256 acc;
        unchecked {
            for (uint256 i = 0; i <= epochIdx; i++) acc += _schedule[i];
        }
        if (acc > 10000) acc = 10000; // defensive cap
        return acc;
    }

    function _vestedBpsNow() internal view returns (uint256) {
        uint256 ep = currentEpoch();
        if (ep == 0) return 0;
        return _vestedBpsAtEpoch(ep - 1);
    }

    function vestedOf(address beneficiary, address token) public view override returns (uint256) {
        uint256 total = grants[beneficiary][token];
        if (total == 0) return 0;
        uint256 bps = _vestedBpsNow();
        return (total * bps) / 10000;
    }

    function claimableOf(address beneficiary, address token) public view override returns (uint256) {
        uint256 v = vestedOf(beneficiary, token);
        uint256 c = claimed[beneficiary][token];
        return v > c ? (v - c) : 0;
    }

    function _snapshotSchedule() internal view returns (uint256[] memory out) {
        uint256 len = _schedule.length;
        out = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = _schedule[i];
        }
    }

    /* =======================================================
                       Grants / Beneficiary set
       ======================================================= */

    function grant(address beneficiary, address token, uint256 amount) external override {
        if (beneficiary == address(0) || token == address(0)) revert ZeroAddress();
        grants[beneficiary][token] += amount;

        if (!_seenTokenForBeneficiary[beneficiary][token]) {
            _seenTokenForBeneficiary[beneficiary][token] = true;
            _beneficiaryTokens[beneficiary].push(token);
        }

        emit Granted(beneficiary, token, amount);
    }

    /* =======================================================
                             Claims
       ======================================================= */

    function claim() external override {
        _claim(msg.sender, type(uint256).max);
    }

    function claim(uint256 epoch) external override {
        _claim(msg.sender, epoch);
    }

    function claimFor(address beneficiary) external override {
        _claim(beneficiary, type(uint256).max);
    }

    function claimFor(address beneficiary, uint256 epoch) external override {
        _claim(beneficiary, epoch);
    }

    function _claim(address beneficiary, uint256 epochLimit) internal {
        // Nothing is claimable before the first epoch boundary
        uint256 epNow = currentEpoch();
        require(epNow > 0, "too-early");

        uint256 effectiveEpoch = epNow - 1; // most recently completed epoch
        if (epochLimit != type(uint256).max && epochLimit < effectiveEpoch) {
            effectiveEpoch = epochLimit;
        }

        uint256 bps = _vestedBpsAtEpoch(effectiveEpoch);

        address[] storage toks = _beneficiaryTokens[beneficiary];
        if (toks.length == 0) revert NoGrants();

        for (uint256 i = 0; i < toks.length; i++) {
            address token = toks[i];
            uint256 total = grants[beneficiary][token];
            if (total == 0) continue;

            uint256 vested = (total * bps) / 10000;
            uint256 already = claimed[beneficiary][token];
            if (vested <= already) continue;

            uint256 toPay = vested - already;
            claimed[beneficiary][token] = vested;

            // Pull funds from vault
            IERC20(token).safeTransferFrom(vault, beneficiary, toPay);
            emit Claimed(beneficiary, token, toPay, effectiveEpoch);
        }
    }

    /* =======================================================
                       Admin (only Treasury)
       ======================================================= */

    function setEpochSeconds(uint256 newEpochSeconds) external override onlyTreasury {
        if (newEpochSeconds == 0) revert EpochZero();
        uint256 old = epochSeconds;
        epochSeconds = newEpochSeconds;
        emit EpochSecondsUpdated(old, newEpochSeconds);
    }

    function setStartTime(uint256 newStartTime) external override onlyTreasury {
        uint256 old = startTime;
        startTime = newStartTime;
        emit StartTimeUpdated(old, newStartTime);
    }

    function setSchedule(uint256[] calldata newScheduleBps) external override onlyTreasury {
        uint256 sum;
        for (uint256 i = 0; i < newScheduleBps.length; i++) sum += newScheduleBps[i];
        if (sum > 10000) revert ScheduleSumTooLarge();

        delete _schedule;
        for (uint256 i = 0; i < newScheduleBps.length; i++) _schedule.push(newScheduleBps[i]);
    emit ScheduleReplaced(_snapshotSchedule());
    }

    function setScheduleAt(uint256 index, uint256 bps) external override onlyTreasury {
        require(index < _schedule.length, "index OOB");

        // Check sum constraint with replacement
        uint256 sum;
        for (uint256 i = 0; i < _schedule.length; i++) {
            if (i == index) sum += bps;
            else sum += _schedule[i];
        }
        if (sum > 10000) revert ScheduleSumTooLarge();

        uint256 old = _schedule[index];
        _schedule[index] = bps;
        emit ScheduleEntryUpdated(index, old, bps);
    }

    function addScheduleTail(uint256[] calldata tailBps) external override onlyTreasury {
        uint256 sum;
        for (uint256 i = 0; i < _schedule.length; i++) sum += _schedule[i];
        for (uint256 j = 0; j < tailBps.length; j++) sum += tailBps[j];
        if (sum > 10000) revert ScheduleSumTooLarge();

        for (uint256 j = 0; j < tailBps.length; j++) _schedule.push(tailBps[j]);
        emit ScheduleTailAdded(tailBps);
    }

    function clearSchedule() external override onlyTreasury {
        delete _schedule;
        emit ScheduleCleared();
    }
}