# 0003 — Play-mining distributes the token

**Status:** accepted, 2026-10-28 (Q4–Q7; cap lowered 2026-10-29)

## Context

LMS needs a way into players' hands that is not a sale. Paying it for play
invites wash trading: one person running several wallets in a lobby can farm
rewards. Rewards that vote at once would also let a farmer buy governance.

## Decision

- Half the supply is paid to players over four years, by the **fees** each
  paid in settled matches — not by wins, which are zero-sum and can be
  arranged.
- No market price inside the protocol: rewards are a weekly budget split by
  fees, not a price feed.
- Two caps: **10,000 LMS per ETH of fees** (lowered from 100k), and a per-wallet
  cap per week. Only matchmade lobbies earn.
- Rewards **vest linearly over 6 months** and do not vote while vesting; votes
  need vested LMS staked in `StakedLms`.
- Liquid LMS can pay up to 50% of a seat's fee at a governance-set rate, and
  that LMS is burned when the match settles.
- The emission schedule can change by governance.

## Consequences

- The per-wallet cap does not stop sybils; a farmer uses more wallets. The real
  bound is the per-ETH cap: every LMS costs at least 1e-4 ETH of real fees,
  together with matchmaking and vesting. The README works through the
  economics.
- Honest players earn ten times less per match than under the old cap;
  governance can raise it.
- Governance starts quiet: nothing votes until players hold enough vested,
  staked LMS to meet the quorum floor.
