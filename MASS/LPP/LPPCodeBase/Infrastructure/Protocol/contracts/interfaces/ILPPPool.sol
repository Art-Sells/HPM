// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

import './pool/ILPPPoolImmutables.sol';
import './pool/ILPPPoolState.sol';
import './pool/ILPPPoolDerivedState.sol';
import './pool/ILPPPoolActions.sol';
import './pool/ILPPPoolOwnerActions.sol';
import './pool/ILPPPoolEvents.sol';

/// @title The interface for a Pool
/// @notice A pool facilitates supplicating and automated market making between any two assets that strictly conform
/// to the ERC20 specification
/// @dev The pool interface is broken up into many smaller pieces
interface ILPPPool is
    ILPPPoolImmutables,
    ILPPPoolState,
    ILPPPoolDerivedState,
    ILPPPoolActions,
    ILPPPoolOwnerActions,
    ILPPPoolEvents
{

}
