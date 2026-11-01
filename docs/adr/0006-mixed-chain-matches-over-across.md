# 0006 — Mixed-chain matches over Across

**Status:** accepted, 2026-10-28 (Q14; bridge chosen 2026-10-29)

## Context

Players on different chains should share one lobby and one prize pool. The
earlier design sent a join as a LayerZero message with executor value, which
meant a messenger and peers to configure per chain, and value that a message
bus does not really move.

## Decision

Mixed-chain matches go over a **value bridge**: **Across**. A spoke's
`SpokeRouter` deposits the stake with a join message; a relayer fills it on the
hub to `BridgeJoinReceiver`, which seats the player through
`GameEscrow.bridgeJoin`. No LayerZero, no executor value. The way back out is a
signed `Withdrawal` that bridges a hub balance to a chain the player names.

Stargate v2 was ruled out: it has no Base Sepolia deployment.

## Consequences

- Nothing of ours to configure on a spoke, and nothing to forge: only the hub
  SpokePool can make the receiver seat anyone, and only with real ETH.
- A fill never reverts on the hub; a seat that is gone is credited to the
  player, and an unroutable fill waits for the timelock to `recover` it.
- Across's testnet is unreliable (slow fills, no relayer incentives, unfilled
  deposits not refunded), so the main testnet flow uses mock pools and a local
  relayer, and the real integration is proven by fork tests against mainnet
  SpokePools. A live testnet join is an optional demo.
