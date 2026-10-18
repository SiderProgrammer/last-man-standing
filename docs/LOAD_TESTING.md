# Load testing

`scripts/load-test.mjs` opens many real WebSocket players against a running
server and reports what they experienced. Each player is a `BotClient` from
`packages/harness`: it signs its login nonce with its own key, opens a practice
room against three house bots, and plays with commit/reveal exactly as the
browser does. Players are spread across worker threads so the generator's own
signing does not serialise on one core.

## Running it

```bash
npm run load:server          # built server on :8789, metrics :9465, per-IP limits opened up
npm run load -- --url ws://localhost:8789 --metrics http://localhost:9465/metrics --clients 1000
```

| Option | Default | |
| --- | --- | --- |
| `--clients` | 1000 | players to open |
| `--workers` | cores − 1, max 8 | generator threads |
| `--ramp` | 200 | new connections per second |
| `--duration` | 60 | seconds to hold after the ramp |
| `--mode` | `play` | `play`, or `idle` (log in, then hold: a connection soak) |
| `--think-min` / `--think-max` | 500 / 3000 | ms before each commit |
| `--hold` | off | send moves as held commits |
| `--json` | | write the report to a file |
| `--slo-connect-pct`, `--slo-auth-p99`, `--slo-round-p99`, `--slo-error-pct` | 99, 1000, 500, 1 | the run exits 1 if any fails |

`npm run load:server` (`scripts/load-server.mjs`) exists because every load
client comes from one IP: it raises the per-IP connection, connect-rate and
login-rate limits through `MAX_CONNECTIONS_PER_IP` and `GATEWAY_LIMITS`. Never
run production with that profile.

The report gives login latency (socket open to `authed`), reveal→round
latency (this player's last action to the round broadcast, which is the
server's critical path), error counts by message, close codes, and the
server's peak event-loop lag and memory, scraped from `/metrics` during the run.

### Generator limits

One machine can only generate so much. For runs past a few thousand players:

- Run the generator on other hosts than the server: it signs every login and
  shares the CPU otherwise. The numbers below had both on one machine.
- Raise the file-descriptor limit (`ulimit -n 65535`) on Linux generators.
- One source IP has about 28k ephemeral ports to one destination; 10k+ needs
  several generator hosts or source addresses.
- Prefer Linux for the generator; Windows' TCP stack hits its limits sooner.

## Baseline (2026-10-18)

One 16-thread Windows desktop running both the server (`npm run load:server`)
and the generator (4–6 workers), practice mode, 3 house bots per player,
`REPLAY_MS=2500`, 0.5–3 s think time. Clean server per run.

| Players | Mode | Connected | Login p99 | Reveal→round p50 / p99 | Peak loop lag | Peak RSS |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000 | play, inline verify | 100% | 2,163 ms | 51 / 386 ms | 245 ms | 149 MB |
| 1,000 | play, verify pool | 100% | **86 ms** | 38 / **107 ms** | 154 ms | 237 MB |
| 1,500 | play | 100% | 935 ms | 233 / 890 ms | 294 ms | 290 MB |
| 2,000 | play | 100% | 6,029 ms | 1,314 / 1,888 ms | 269 ms | 331 MB |
| 5,000 | idle | 100% | 64 ms | — | 64 ms | 396 MB |
| 5,000 | play | 46% | collapse (51k reconnects) | | 300 ms | 335 MB |

No run had a protocol error: every failure was latency or refused connections.

## What it found

**1. Login signature recovery blocked the event loop (fixed).** Recovering a
secp256k1 signature costs about 5.5 ms of pure-JS CPU. Done inline, a burst of
logins stalled every room's clock with it, and one core topped out near 180
logins a second. The first 1,000-player run had a 2.8 s login p99 and 117
connections reset mid-ramp. Recovery now runs on a worker-thread pool
(`gateway/verifyPool.ts`, `VERIFY_THREADS`). Login p99 dropped 25×, and the
reveal→round p99 dropped 3.6× because the rooms stopped competing with
logins. EOA logins also no longer cost an RPC call: local recovery comes first,
and only a signature that does not recover goes to the ERC-1271 check.

**2. Connections are cheap; game rounds are not.** 5,000 idle logged-in
sockets cost about 50 KB each, with 64 ms loop lag. The ceiling is gameplay:
one process resolves about 440 rounds a second before the main thread
saturates. At this pacing that is roughly 1,000–1,500 concurrent practice
players. Practice is the expensive case, because the server plays three seats
for every human; a four-human staked table costs about a quarter as much per
player.

**3. Hashing is most of a round.** An in-process benchmark (no network)
resolves 1,300 rounds/s, about 0.77 ms each, and its CPU profile is about 45%
keccak and 15% ABI encoding: bot PRNG draws, bot salts, four commitment
checks, the round seed, the round hash, the history chain. The hashes are
consensus-critical and cannot change. Ways to scale, cheapest first:

- **Fewer hashes for house bots.** The `Prng` hashes once per draw; drawing
  several values from one digest would cut bot cost noticeably without
  touching anything a third party verifies.
- **A native keccak.** Swapping the pure-JS implementation for a native one
  is likely 5–10× on the hottest function.
- **More processes.** Rooms are independent. Shard matches across processes
  or hosts with sticky routing by `matchId`; the gateway limits and the
  practice-room cap are per process today and would need shared state.

**4. Overload collapses rather than degrading.** Past the knee, slow logins
time out, clients reconnect, and every reconnect costs another signature, so
the 5,000-player run spent its CPU on 51k reconnects. Before going to
production, add load shedding: refuse new practice rooms (or new connections)
once `lms_lobby_tick_seconds` or event-loop lag crosses a threshold, so that
players already in a match keep their latency.
