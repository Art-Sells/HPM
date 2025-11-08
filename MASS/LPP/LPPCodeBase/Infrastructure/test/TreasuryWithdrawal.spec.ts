// Placeholder: add Treasury Withdrawal Tests here...
// also add whether (after mint with rebate), the treasuries go into the vault
//      - Rotation race: in same block, old Treasury cannot call createPoolViaTreasury after rotate
 //     - Hook wiring race: only one setPoolHook succeeds; conflicting second attempt reverts

//add snapshots to verify