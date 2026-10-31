# 0001 — Built to a real-money bar, run on testnet

**Status:** accepted, 2026-10-28 (Q0)

## Context

The project is a portfolio piece. It could cut every corner a demo can get away
with, or be held to the standard of a product that custodies other people's
money. The architecture review found the gaps between the two: trust that was
assumed rather than stated, keys that did too much, and paths where a crash or a
reorg lost a match.

## Decision

Build it to the bar of a real product that holds money: stated threat and trust
models, separated keys, pull payments, invariants, crash safety, and docs that
say what is and is not guaranteed. Run it on testnet only.

## Consequences

- Mainnet is out of scope, and the README says what it would take: independent
  signers for the Safe (one person holds all three keys today), an audit, and a
  gambling licence, which is a legal question, not an engineering one.
- Every later decision is judged by "would this be acceptable with real
  money", which is why trade-offs such as the guardian's liveness assumption
  are written down rather than left implicit.
