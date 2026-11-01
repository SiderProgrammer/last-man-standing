# 0002 — Verifiable, not enforced

**Status:** accepted, 2026-10-28 (Q1–Q3; dispute default 2026-10-29)

## Context

The server is authoritative: it runs the round clock, resolves rounds and has
the attestor sign the result. Enforcing correctness on-chain would mean a
Solidity copy of the resolution kernel, kept bit-for-bit identical to the
TypeScript one while the rules still change, or a fraud-proof game with bonds
and slashing. Trusting the server blindly is not acceptable either (0001).

## Decision

Results are **verifiable, not enforced**:

- players sign every commit and reveal with the key their wallet granted, and
  the server signs a receipt for each commit;
- the transcript is archived and its hash is part of the signed result;
- every player's browser replays the match from chain data and the transcript
  and checks the result;
- any seated player can `dispute` during the challenge window, and the
  guardian vetoes (every stake refunded) or dismisses;
- `hold` stays: the server reveals a move a player handed over with its commit
  if the player drops.

A dispute extends finalisation by 48 hours. If the guardian neither vetoes nor
dismisses by then, the result finalises.

## Consequences

- A fabricated result is provable by anyone, but stopping it depends on the
  guardian acting: the **liveness assumption**, stated in the README.
- The server can drop a move, but not invent or alter one; a dropped move the
  player holds a receipt for is provable.
- No on-chain replay and no slashing, so the kernel can change without a
  contract upgrade.
- The attestor is not independent of the operator yet; it runs in its own
  process and replays before it signs, which is a seam for independence, not
  independence.
