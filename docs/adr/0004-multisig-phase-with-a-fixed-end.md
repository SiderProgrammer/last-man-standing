# 0004 — A multisig phase with a fixed end

**Status:** accepted, 2026-10-28 (Q8–Q12; treasury, guardian and re-pause defaults 2026-10-29)

## Context

Token governance cannot run the protocol on day one: nothing is staked, so
nothing votes. Someone has to be able to propose and to stop an exploit. A
multisig that keeps those powers forever is just an owner key with extra steps,
and one that can renew its own powers is the same thing.

## Decision

- A **2-of-3 Safe** proposes and cancels through the timelock, via
  `MultisigPhase`, until a date **written into the contract** at deploy (a year
  by default, two at most). After it, anyone calls `retire()`; the Safe cannot
  stop it or schedule anything that outlasts the phase.
- The **guardian** is a separate hardware-wallet EOA, not the Safe. It pauses
  play at once, for **7 days**, and vetoes proposed results. After a pause ends
  it cannot pause again for 7 days; only governance extends or renews a pause.
- The **treasury** is the timelock, so spending fees always takes a proposal.
- Safe, guardian and treasury are three different addresses.
- The 5M liquidity LMS sits in `LiquidityReserve`, which cannot stake or
  delegate and pays only a recipient the timelock approves, so the Safe cannot
  use it to meet quorum alone.
- Vesting rewards cannot vote (0003). Every role is in the README's roles table.

## Consequences

- On testnet one person holds all three Safe keys on separate devices; mainnet
  needs independent signers.
- A compromised guardian can stop play for a week at a time, with a week of
  play between, until governance replaces it; refunds and withdrawals never
  pause.
- The phase can end before governance is ready to act. That is the price of a
  removal nobody can block.
