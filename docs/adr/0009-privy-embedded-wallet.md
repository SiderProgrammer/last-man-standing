# 0009 — Privy as the embedded wallet

**Status:** accepted, 2026-10-29 · **not yet integrated**

## Context

One-click play (0008) needs a wallet that signs a 7702 authorisation for our
delegate. Injected wallets will not; a dev burner is not a product. Players
should also keep one address on every chain, since the address is the
identity.

## Decision

- **Privy** is the embedded wallet: one EVM wallet, the same address on Base,
  Arbitrum, Optimism and L1.
- Injected wallets and Coinbase Smart Wallet also connect, with the normal
  flow.
- **Turnkey** is the fallback if Privy cannot sign a 7702 authorisation for a
  delegate that is not its own. If neither can, embedded wallets fall back to
  the normal flow; the contracts do not change either way.

## Consequences

- The client takes an embedded wallet as a viem local account
  (`Wallet.fromAccount`), which is what Privy's wallet becomes through
  `toAccount`; `npm run check:one-click` proves that path with a local account.
- The Privy check itself (an authorisation for our delegate on Base Sepolia)
  needs a Privy app and is not done, so Privy is not in the client yet. The
  README's wallet matrix says so.
