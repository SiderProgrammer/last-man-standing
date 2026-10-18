# Chaos testing

`packages/server/test/chaos.test.ts` runs real `BotClient`s (from
`packages/harness`) against a real `Gateway` and `Lobby`, over a simulated
network that misbehaves. It runs with the normal test suite on a handful of
seeds; a soak runs hundreds.

```bash
npx vitest run packages/server/test/chaos.test.ts               # default seeds
CHAOS_SEEDS=200 npx vitest run packages/server/test/chaos.test.ts   # soak: seeds 1..200
CHAOS_SEEDS=27,34 npx vitest run packages/server/test/chaos.test.ts # reproduce specific seeds
```

## How it works

`packages/server/test/sim.ts` is a deterministic world:

- **Virtual clock.** Every timer — the lobby tick, the gateway sweep, bot
  think time, reconnect backoff, settlement retries, network delivery — is
  scheduled on it, so thirty minutes of play take a fraction of a second.
- **Simulated network.** Each connection carries frames FIFO per direction,
  as TCP does, with injectable faults (`Faults`):

  | Fault | Models |
  | --- | --- |
  | `minDelayMs`–`maxDelayMs` | latency and jitter |
  | `resetRate` | a connection reset; every frame in flight both ways is lost |
  | `stallRate` | a half-open connection: frames vanish silently until the server's heartbeat gives up (`heartbeatMs`) |
  | `refuseRate` | a refused connection attempt |

- **Server restart.** `world().restart()` drops every connection and replaces
  the lobby and gateway with fresh ones, as a process restart does.
- **Relayer failures.** A relayer whose `settle` fails at a configurable rate.
- **Reproducible.** Everything random comes from the seed. Real signature
  recovery is replaced by a deterministic stand-in (`simSignature`), because
  viem's recovery resolves through a dynamic import whose timing the clock
  cannot control. The real verification has its own tests. A test asserts
  that a seed replays exactly.

## What must hold

For every seed:

- **Liveness.** Every bot finishes its games within a bound. A failure lists
  each stuck bot with its last events.
- **Integrity.** Every archived staked result replays to itself through
  `verifyResult`.
- **Hygiene.** Once everyone has left: no open sessions and no rooms.
- **No unexpected errors.** Only the errors a drop legitimately causes (a
  stale move refused by its aim, a move after its window, a match that no
  longer exists) are allowed.
- **Settlement.** A staked table settles on its first successful attempt, at
  most once, within three attempts, or is left to refund.

## What it found

Each of these was a failing seed before its fix.

1. **Moves sent between a reconnect and the re-login were lost.** The server
   refuses anything but `auth` from a socket that has not logged in, so a
   commit sent in that gap disappeared. The browser's `Net` had the same race:
   it wrote to any open socket. It now queues everything but the login until
   the socket has logged in.
2. **Practice match ids repeated across restarts.** The nonce started at zero
   in every process. After a restart, a player re-attaching to its old match
   id landed, as a spectator, in a stranger's new match that reused it. It
   now starts at a random 64-bit offset per process.
3. **Stale moves were taken for the current round.** Commit and reveal frames
   named neither match nor round. A commit computed for an earlier round,
   delayed in flight or flushed from the offline queue, was accepted as the
   current round's and could then never be opened. Moves now carry an
   optional `matchId` and `round` (`MoveAim`), and the server refuses a
   mismatch with an error naming the round.
4. **A failed settlement was never resubmitted.** One RPC timeout meant the
   stakes waited for the escrow's refund deadline. `Lobby` now retries with
   backoff (2 s, then 10 s by default).
5. **A malformed WebSocket frame crashed the process** (found while
   load-testing, see `docs/LOAD_TESTING.md`). An `error` event with no
   listener is thrown by Node.

## Not covered yet

- Chain-side chaos: RPC errors and stale blocks under the bridge, `anvil_reorg`
  of `MatchCreated` or `MatchStarted`. That needs a fork run.
- Cross-chain delivery faults: dropped, delayed or duplicated LayerZero
  messages, and a reverting `lzReceive`, through `MockLayerZeroEndpoint`.
- Network faults between the server and its RPC (Toxiproxy).
