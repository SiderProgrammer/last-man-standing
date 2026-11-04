# 0012 — Launch scope: mainnet demo, free hosting, two things deferred

**Status:** accepted, 2026-11-04 · replaces "testnet only" in 0001 and the timing, not
the choice, of 0009

## Context

The project is still a portfolio piece, and nothing is deployed on a public chain yet.
Getting it in front of a reviewer needs decisions on where it runs, how far it goes, and
what can wait. Contracts cannot be upgraded, so anything left out of a deployment stays
out of it.

## Decision

- **Testnet first, then a mainnet demo.** Mainnet is there to show the protocol can be
  deployed and run on a real chain. It is not promoted, nobody is meant to put money in,
  and it is not a product.
- **Render's free tier** hosts the client and the server, kept awake by an external ping.
  Neon's free tier holds the database.
- **Privy is deferred, not dropped.** It is still the planned embedded wallet, and 0009
  still stands. Nothing it relies on is removed.
- **The dispute bond is deferred.** A dispute costs only gas for now, which is listed as
  a known limitation.

## Consequences

- Mainnet does not meet the bar 0001 set out: one person holds every Safe key, and the
  reviews are AI-assisted rather than an independent audit. The README says so. "No
  promotion" does not stop anyone calling the contracts with real ETH, so
  [TODO.md](../TODO.md), section 8, puts limits on the stake ahead of the deploy.
- Without Privy, one-click play is proven only on a local node with
  `npm run check:one-click`, and production visitors use wallet-free practice or the normal
  wallet flow.
- A bond added later means a new escrow, because the contracts cannot be upgraded. Until
  then any seated player can hold a payout back 48 hours for the price of gas.
- Restarts become routine, only one server can stay awake on the free hours, and nothing
  has been measured on Render's CPU. [HOSTING.md](../HOSTING.md) lists the risks, including
  two to test first because they could break redeploys.
