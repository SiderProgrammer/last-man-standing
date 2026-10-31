# 0005 — Hub on Base, stakes in native ETH

**Status:** accepted, 2026-10-28 (Q13; spokes and stake asset by default 2026-10-29)

## Context

All match state and value has to live on one chain, so settlement is one
transaction against one balance. That chain should be cheap per round of
settlement, have a working VRF and Across deployment on its testnet, and share a
gas token with the chains players arrive from.

## Decision

- The hub is **Base** (Base Sepolia on testnet). Minimum stake 0.001 ETH.
- Spokes are **Arbitrum, Optimism and Ethereum L1** (Arbitrum Sepolia, OP
  Sepolia and Sepolia on testnet).
- Stakes are **native ETH only**.

## Consequences

- Every chain involved uses ETH for gas, so a stake has no price risk in
  transit and the escrow never holds a token.
- A join from L1 is one transaction, so its high gas is paid once per join.
- Other tokens are reached through `ZapJoin`, which swaps for exactly the stake
  before the escrow sees anything.
- Base has a sequencer; the escrow checks the sequencer uptime feed where one
  exists, and Base Sepolia has none.
