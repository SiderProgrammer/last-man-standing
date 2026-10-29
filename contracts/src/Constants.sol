// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// 100%, in basis points. Every `*Bps` value is a fraction of this.
uint256 constant BPS_DENOMINATOR = 10_000;

// How long after its join deadline a quorate lobby can only be locked, not cancelled.
uint64 constant LOCK_GRACE = 10 minutes;
// How long a locked lobby waits for its seed before it may be cancelled.
uint64 constant RANDOMNESS_TIMEOUT = 1 hours;
// How long a dispute holds back a result's payout.
uint64 constant DISPUTE_EXTENSION = 48 hours;
