# 0008 — Off-chain session grants; one-click play through EIP-7702

**Status:** accepted, 2026-10-28 (Q20; relayer limits 2026-10-29)

## Context

A match has a commit and a reveal every round, and a wallet prompt for each is
unplayable. The earlier delegate let a session key answer ERC-1271 for the
account, which meant anything that checks ERC-1271 — a permit, an order —
took the key's word for the wallet's.

## Decision

- **Login is an off-chain EIP-712 session grant**: the wallet signs once for a
  browser-held key, which signs the login and every move; the server checks the
  grant. It has no chain id in its domain, so a wallet on a spoke can sign it.
- `SessionKeyDelegate` stays, **without** the session-key branch in
  `isValidSignature`: ERC-1271 answers for the root key only.
- `executeWithSession` is the **one-click** feature: `join` and `withdrawFor` on
  the escrow only, with per-call and total caps set at grant, submitted by a
  relayer that pays the gas.
- Relayer-paid gas is a subsidy someone can drain, so relayed calls have a
  per-wallet daily quota and only calls that simulate are sent.
- Burner and embedded wallets get one-click play; injected wallets keep the
  normal flow.

## Consequences

- Every move in a transcript is provably its player's, with no prompt after
  login.
- One-click play needs a wallet that can sign a 7702 authorisation for our
  delegate, which injected wallets cannot be asked for (0009).
- One-click play is Base only. Spoke joins stay normal transactions through
  `SpokeRouter`; one-click on spokes is out of scope.
