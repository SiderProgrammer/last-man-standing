# Architecture decision records

One short record per decision that shaped the design: the situation, what was
decided, and what it costs. They are the decisions listed in
[FIX_PLAN.md §0](../FIX_PLAN.md#0-decisions-this-plan-is-built-on), made on
2026-10-28 and 2026-10-29, with the defaults accepted the same day. A record is
not edited when a decision changes; a new one supersedes it.

| # | Decision | Answers |
| --- | --- | --- |
| [0001](0001-built-to-a-real-money-bar.md) | Built to the bar of a real-money product, run on testnet | Q0 |
| [0002](0002-verifiable-not-enforced.md) | Results are verifiable, not enforced; the guardian decides disputes | Q1–Q3 |
| [0003](0003-play-mining-distributes-the-token.md) | Play-mining distributes the token, capped and vested | Q4–Q7 |
| [0004](0004-multisig-phase-with-a-fixed-end.md) | A multisig phase that ends on a date in the contract; separate guardian and treasury | Q8–Q12 |
| [0005](0005-hub-on-base-native-eth.md) | Hub on Base, stakes in native ETH, spokes on Arbitrum, Optimism and L1 | Q13, Q15, Q16 |
| [0006](0006-mixed-chain-matches-over-across.md) | Mixed-chain matches over Across, a value bridge | Q14 |
| [0007](0007-vrf-paid-in-eth-owned-by-the-safe.md) | Chainlink VRF v2.5 paid in ETH, on a subscription the Safe owns | Q17 |
| [0008](0008-sessions-and-one-click-play.md) | Off-chain session grants; one-click play through EIP-7702 | Q20 |
| [0009](0009-privy-embedded-wallet.md) | Privy as the embedded wallet, Turnkey as the fallback | Wallets |
| [0010](0010-break-freely-one-instance.md) | Wire, storage and schema may break; fresh deploys; one server instance | Q21–Q24 |
| [0011](0011-two-resolvers-pinned-by-golden-transcripts.md) | Two match resolvers, pinned by golden transcripts | M22 |
