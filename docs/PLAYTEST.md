# Playtesting every feature from 4, 6 or 8 accounts

Two environments, the same tools:

| | Local rehearsal fork | Testnet |
| --- | --- | --- |
| Chains | hub Base (8453); spokes Arbitrum One (42161), OP Mainnet (10), Ethereum (1); all forked locally | hub Base Sepolia (84532); spokes Arbitrum Sepolia (421614), OP Sepolia (11155420), Sepolia (11155111) |
| Deploy | `Deploy.s.sol` / `DeploySpoke.s.sol` on their **production path**, run fresh on every start | the committed `contracts/deployments/<chainId>.json` |
| Randomness | Chainlink's real Base VRF coordinator and a real subscription; the script delivers each answer as the coordinator does | Chainlink VRF on Base Sepolia |
| Across | the real SpokePools on every fork; the script plays the relayer (fills after 5 s, no fee) | Across's real testnet pools; `up --relay` fills the joins from `DEPLOYER_PK`, since Across's testnet relayers skip them |
| Tokens | every token with a live Uniswap v4 route at the fork block (USDC, USDT, DAI, cbBTC) | USDC, if a v4 route prices (`doctor` says) |
| Time | `npm run play -- warp 1h` moves every chain | real time only |
| Players | 8 anvil test accounts, 10,000 ETH on every chain, tokens, 50k LMS, 300k sLMS | 8 generated keys, funded from your deployer |
| Start | `npm run fork:base` | `npm run testnet -- up` |

Every seat can be a browser tab (`/?player=N` signs with player N's key, no
wallet extension) or a bot (`npm run play`), in any mix. Bots speak the real
wire protocol: they log in with a session grant, sign every commit and reveal,
and stake from their own account.

## The local rehearsal fork

```bash
npm run fork:base
```

Needs Foundry. It forks with an archive RPC: `ALCHEMY_API_KEY`, or the key of
any Alchemy URL already in `.env`, or `FORK_BASE_RPC_URL`, `FORK_ARB_RPC_URL`,
`FORK_OP_RPC_URL` and `FORK_ETH_RPC_URL`. Without one it falls back to
publicnode, which stops serving the fork block after a few minutes.

**The Alchemy app must have every network enabled**: Base, Arbitrum, OP Mainnet and
Ethereum (dashboard.alchemy.com → the app → Networks). The script checks each one
before it starts and says which is missing. To run fewer spokes, set
`FORK_SPOKES=arb` (or `arb,op`); the first one listed is what `&chain=spoke` and
`--from spoke` mean.

Startup takes two to three minutes: it forks every chain, creates and funds a
VRF subscription as the Safe, deploys the hub and each spoke, adds the VRF adapter as a
consumer, funds the players, and starts the server (`:8791`) and client
(`:5176`). The fork's registries and `profile.json` go to
`contracts/deployments/fork/` (gitignored). A real registry for any of those
chains, when it exists, is put back as it was. Ctrl+C stops
everything; every start is a fresh deploy.

Unless `FORK_MAINNET_ECONOMICS=1` is set, the script also switches on two
things Base leaves off by default: half of each fee goes to stakers, and the
LMS fee discount. It does this as the timelock. To leave them off and turn them
on through governance, see §9.

Open the tabs you want to play by hand:

```
http://localhost:5176/?player=1   …   http://localhost:5176/?player=8
http://localhost:5176/?player=2&chain=arb       player 2, staking from Arbitrum
http://localhost:5176/?player=3&chain=op        player 3, staking from OP Mainnet
http://localhost:5176/?player=4&chain=eth       player 4, staking from Ethereum
```

`&chain=` also takes a chain id (`&chain=10`) or `spoke` (the first one). A chain
the fork does not run is an error when you connect, not a silent switch to Base.
Blocks come as on the real chains: every 2 s on Base and OP, every second on
Arbitrum, every 12 s on Ethereum.

The same with bots: `npm run play -- join <match> --players 2 --from op`.

Each tab is a different wallet, and its title shows which. The commit window is
60 s (`COMMIT_MS`), so you can switch between tabs; background tabs still play.

**Roles on the fork** (`npm run play -- info`): each one is its own anvil
account. The deployer deploys and keeps nothing. The Safe owns the VRF
subscription and proposes through `MultisigPhase`. The guardian pauses and
vetoes; `play` signs as it. Attestor, keeper, matchmaker and session relayer are
the server's four keys.

## Testnet

Once:

```bash
npm run testnet -- doctor            # what is missing, from RPC limits to the VRF subscription
npm run testnet -- accounts          # 8 player keys into .testnet-accounts.json (gitignored)
npm run testnet -- fund              # shows the plan; nothing is sent
npm run testnet -- fund --yes        # sends it, from FUNDER_PK or DEPLOYER_PK
```

`fund` tops every player up to `--hub 0.01` ETH on Base Sepolia and `--spoke
0.005` on one spoke (`--spoke-chain arb|op|eth`, default Arbitrum Sepolia). It
tops the keeper, matchmaker and relayer keys up to `--roles 0.02`. To fund only
the players who will stake from a spoke: `--spoke-players 5-6`. To give each
spoke its own players in one run: `--spoke-players arb:2,op:3,eth:4`.

Then:

```bash
npm run testnet -- up                # server :8787 + dev client :5173, per-tab burners
```

`up` reads `.env`, forces `CHAIN_ID=84532`, keeps the archive in memory (`--db`
uses `DATABASE_URL`), and sets a 60 s commit window, 4/6/8-seat tiers at
0.001 ETH, and generous per-IP login limits. It fills in `SPOKES`,
`AVATAR_COLLECTIONS` and the token routes from the registries.

**Do not run two servers on one escrow with the same keys.** If the hosted
server is up, stop it while you test locally, or the two race for nonces and
both run the matchmaking queue.

Use the same `play` commands with `--net testnet` (or `PLAY_NET=testnet`).
On testnet, `--from arb|op|eth` picks the spoke a `join` or `queue` stakes from
(`--from spoke` is the first one), and `--relay` fills the deposit at once.

### Four players on four chains

One seat on each chain: P1 on the hub, P2 on Arbitrum Sepolia, P3 on OP Sepolia,
P4 on Sepolia.

```bash
npm run testnet -- fund --hub 0.005 --spoke-players arb:2,op:3,eth:4 --yes
npm run testnet -- doctor            # each player's ETH on every chain
npm run testnet -- up --relay
```

`up` prints the four tabs; open them:

```
http://localhost:5173/?player=1
http://localhost:5173/?player=2&chain=arb
http://localhost:5173/?player=3&chain=op
http://localhost:5173/?player=4&chain=eth
```

`&chain=` also takes a chain id (`&chain=11155420`). In each tab, **Stake** on
the same lobby: open one with `npm run play -- create --stake 0.001 --seats 4 --as 1
--net testnet`. It shows in every tab's lobby list, or add `&lobby=<id>` to a tab's address to
highlight it. P1 joins on Base Sepolia.
The others pay the stake plus Across's fee on their own chain, and `up --relay`
fills each deposit on the hub (`[relay] P3 staked … on OP Sepolia`). The seat
shows its chain's badge. `npm run play -- status last --net testnet` lists each
seat's origin.

Every `--relay` fill costs `DEPLOYER_PK` the stake on Base Sepolia, because
Across's testnet may never repay it: keep about 0.001 ETH per spoke join there.
`up --relay` fills only deposits from the players in `.testnet-accounts.json` to
the hub's `BridgeJoinReceiver`, so nobody else can spend it. Without `--relay`,
a spoke join waits for Across's relayers, which left the one such join tried
unfilled (docs/ACROSS.md). It expires after two hours, and its ETH is lost.

## The `play` CLI

```bash
npm run play -- help
```

| Command | What it does |
| --- | --- |
| `accounts` | every player: ETH on every chain, escrow balance, LMS, sLMS |
| `lobbies` / `status <match>` | lobby list; one lobby's seats, origins, result and balances |
| `table --seats 6 --humans 2` | P1 opens a lobby, bots take seats 3–6 and wait; you join as P1 and P2 in tabs |
| `create`, `join`, `bots`, `fill` | the same in steps: `join` takes `--from spoke` (testnet: `--from arb|op|eth`, `--relay`), `--token USDC`, `--lms 1000` |
| `relay <spoke tx> --from op` | testnet: fills a spoke join's deposit from `DEPLOYER_PK` |
| `queue --seats 8 --players 1-8` | bots matchmake, stake into the matchmade lobby, play |
| `finalize`, `withdraw`, `lock`, `cancel` | the permissionless lifecycle calls |
| `dispute --as N`, `veto`, `dismiss`, `pause` | the dispute path and the guardian |
| `rewards [--claim] [--release]` | play-mining per ended week, claim into vesting, release |
| `gov propose / vote / state / queue / execute` | a full proposal changing the stakers' share of fees |
| `warp 1h \| 2d \| epoch` | fork only: moves every chain's clock |

A match is a full id, `#nonce`, or `last`.

**Clock-sensitive checks first.** One-click play (§10) needs the chain's clock
to match the wall clock. Do it before the first `warp`, or restart the fork.
A paused escrow (§5) stays paused for 7 days of chain time; `warp 7d` ends it.

**After a `warp`, finalize and cancel from the CLI.** The server times the
challenge window and the refund deadlines with its own wall clock, not the
chain's, so after a warp it waits for real time to catch up.
`npm run play -- finalize last` does not wait.

## Feature checklist

Each line gives the fork command (or UI step) first. Notes say what differs on
testnet.

These were run end to end on the fork while the tools were being built:

- §2: 4, 6 and 8 seats, with bots alone and with a human tab.
- §3: a held move revealed while its tab reloaded, a reconnect with no prompt, and a server restart (in memory: refunded).
- §4: payouts, finalize and withdraw.
- §5: dispute, veto, pause and its expiry, and the guardian's cooldown.
- §6: ETH, USDC, USDT, DAI, cbBTC, LMS and a join from Arbitrum.
- §7.
- §8: an 8-seat queue, then claim and release.
- §9: the CLI governance cycle.
- §10: a relayed one-click join (the player paid exactly the stake), and avatars on both chains.
- §11: an expired lobby, then cancel and refund.

The rest are UI paths to click through.

### 1. Practice and login
- [ ] Tab P1 → **Connect wallet** → session key **on**. Start a practice match against 3, 5 and 7 bots, on each difficulty.
- [ ] Refresh mid-round: no wallet prompt (the stored grant logs in), and the round is not lost.
- [ ] **Forget key**, then reconnect: a new grant is signed.

### 2. A staked match, every table size
- [ ] `npm run play -- table --seats 4 --humans 1`, then in tab P1 **Stake** on the lobby → **Enter** → play.
- [ ] Repeat with `--seats 6 --humans 2` and `--seats 8 --humans 3`, one tab per human.
- [ ] All bots: `npm run play -- table --seats 8 --humans 0`.
- [ ] Watch the server log: `locking …`, `[vrf] seeded …`, `opened room …`, then the result is proposed.
- [ ] `npm run play -- status last`: Proposed, with the ranking and the transcript hash.
- [ ] Testnet: the seed arrives from Chainlink in seconds to a minute; if it never does, `doctor` checks the subscription.

### 3. Moves, holding and reconnects
- [ ] Tick **Reveal for me if I disconnect**, commit, close the tab before the reveal: the move still counts.
- [ ] Commit, refresh during the reveal window: the salt survives, and the reveal goes out.
- [ ] Guard or Charge twice in a row: refused (cooldown).
- [ ] Bots with held moves: `bots … --hold`.
- [ ] Server restart mid-match (fork): save any file under `packages/server/src`, and `tsx watch` restarts the server. With `FORK_DATABASE_URL` set, the match resumes from its journal. Use its own database: the server locks it, so never the hosted server's. Without it, the archive is in memory, and the attestor aborts the match and refunds every seat (`status last`: Cancelled).

### 4. Payout, verification and collecting
- [ ] Fork: `npm run play -- warp 61m` → `finalize last` → `status last`: 5% fee, then 60 / 25 / 15 % of the rest.
- [ ] Testnet: wait the 1 h challenge window; the server's keeper finalises on its own.
- [ ] Result screen: the browser re-checks the transcript ("verified"). **Collect** in Winnings, or `npm run play -- withdraw`.
- [ ] History: open a finished match, replay its rounds, and check the Reads panel.

### 5. Disputes and the guardian
- [ ] In the challenge window: `npm run play -- dispute last --as 2` → status shows DISPUTED, deadline +48 h.
- [ ] `veto last`: Cancelled, every stake refundable, LMS discounts returned. Or `dismiss last`, then finalize after the extended deadline (fork: `warp 49h`).
- [ ] `pause`: joins revert; `withdraw` and `cancel` still work. The pause ends after 7 days (`warp 7d`), or by governance.
- [ ] Testnet: the guardian is your hardware wallet. Set `GUARDIAN_PK` in `.env` only if it is a throwaway test key; otherwise send `veto` / `dismissDispute` / `pause` from the wallet itself.

### 6. Every way to pay a stake
- [ ] ETH: the default.
- [ ] Tokens: in the lobby, **Pay with** USDC / USDT / DAI / cbBTC; or `join last --players 2 --token USDC`. The first token join costs an approval first.
- [ ] LMS discount: tick **Pay part of the fee in LMS**; or `join last --players 4 --lms 1000`. Then 1 LMS covers half of a 0.001 ETH stake's fee. It is burned at settlement and refunded on a cancel or veto.
- [ ] From Arbitrum: tab `?player=5&chain=spoke` → **Stake from ARB**; or `join last --players 5 --from spoke`. The seat shows an ARB badge.
- [ ] Testnet: Across's real fee is quoted and paid, and fills take about a minute. To see a refund, stake from the spoke into a lobby that fills first: the stake is credited on the hub.

### 7. Collecting to the spoke
- [ ] Tab `?player=5&chain=spoke` → Winnings → **Collect to Arbitrum** (first click quotes, second signs). The server's relayer submits it on the hub, and Across fills it on Arbitrum.

### 8. Matchmaking and play-mining
- [ ] UI: **Find a match** in two or more tabs on the same tier. `npm run play -- queue --seats 4 --players 3-4` adds bots to the same queue.
- [ ] All bots: `queue --seats 8 --players 1-8`. The lobby is `matchmade`, and only its roster can join.
- [ ] A short table: queue 4 for the 6-seat tier; it opens after 15 s (`MATCHMAKING_FILL_AFTER_MS`).
- [ ] Play-mining counts only matchmade, settled matches, from the first full week after the deploy. Fork: `warp epoch` first, play a queue match, `warp 61m`, `finalize last`, `warp epoch`, then `rewards --claim` (0.5 LMS per seat at 0.001 ETH). After `warp 60d`, `rewards --release`. In the UI, the staking panel shows the same, with **Claim LMS** / **Release LMS**.
- [ ] Testnet: play-mining pays from Thursday 12 Nov 2026 00:00 UTC (week 2967). A week can be claimed the moment it ends.

### 9. Staking and governance
- [ ] Staking panel: stake, unstake (10-day cooldown; fork: `warp 10d`), delegate. **Claim ETH**: the keeper harvests fees every 10 s on the fork, and they stream to stakers.
- [ ] Governance screen, or the CLI on the fork:
  ```bash
  npm run play -- gov propose --bps 6000 --as 1      # prints the id
  npm run play -- warp 1d
  npm run play -- gov vote <id> --players 1-4         # 1.2M sLMS, over the 1M quorum floor
  npm run play -- warp 5d
  npm run play -- gov queue --bps 6000
  npm run play -- warp 3d
  npm run play -- gov execute --bps 6000              # stakers' share is now 60%
  ```
- [ ] Testnet: players hold no sLMS and voting takes 1 + 5 + 3 days. Test the Safe's route through `MultisigPhase` from the Safe app instead.

### 10. One-click play (EIP-7702) and avatars
- [ ] Burner tab → **Turn on** one-click play (one transaction). Then joins and **Collect** go through without a prompt, and the server pays the gas, up to `RELAY_QUOTA_PER_DAY`: the player's ETH drops by exactly the stake.
- [ ] Fork: do this **before any `warp`**. The session's `validUntil` comes from the browser's clock, so once the chain is ahead of it, `grantSession` reverts (`InvalidSession`). Restart the fork to get the clocks back together.
- [ ] **Mint avatar** on Base (tab `?player=N`) and on Arbitrum (`&chain=spoke`). Each seat wears the avatar from the chain it staked from.

### 11. Cancellations
- [ ] An under-filled lobby: `create --seats 4`, `join last --players 1`, then wait 10 min (fork: `warp 11m`) → `cancel last` → `withdraw --players 1`.
- [ ] An oracle that never answers: on the fork the script always answers, so this one is covered only by `GameEscrowTest`.

### 12. Match analyst
- [ ] Start with `GEMINI_API_KEY=… npm run fork:base` (testnet: in `.env`). After a match, **Analyse match**, then click a key moment to replay that round.

## Known limits of the rehearsal

- The VRF answer comes from the coordinator's address but carries no real
  proof, since no Chainlink node serves a fork.
- The Across relayer is ours, fee-free and always on time.
- Anvil's public test accounts are known to everyone. Never send them value on
  a real chain.
