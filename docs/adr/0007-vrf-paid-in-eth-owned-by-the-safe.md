# 0007 — VRF paid in ETH, on a subscription the Safe owns

**Status:** accepted, 2026-10-28 (Q17; payment by default 2026-10-29)

## Context

Every match needs a seed drawn after its seat list is final. Chainlink VRF v2.5
bills a subscription, either in LINK or in native ETH, and whoever owns the
subscription decides which consumers may spend it.

## Decision

- The **Safe owns the VRF subscription**; `ChainlinkVrfAdapter` is a consumer,
  and only the escrow may request through it.
- Requests are paid in **native ETH** (`nativePayment: true`).
- The escrow sees only `IRandomnessOracle`, so VRF can be swapped by
  governance without touching it.

## Consequences

- Nobody has to keep LINK topped up; the subscription is funded in the same
  asset as everything else (0005).
- An open adapter could be drained one request at a time, so consumers are
  registered.
- VRF does not retry a failed callback, so the adapter never reverts on one:
  it stores the word and anyone can `deliver` it again. A request that is never
  answered ends in `cancelMatch` and a refund.
