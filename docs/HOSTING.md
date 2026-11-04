# Hosting on Render's free tier

The decision and why it was made are in [ADR 0012](adr/0012-launch-scope.md). This
page says how the game is meant to run there and what that risks.

**None of this has run on Render yet.** The commands below are what the repo implies,
and the risks come from reading the server's code and Render's docs
([free services](https://render.com/docs/free),
[deploys](https://render.com/docs/deploys)), checked on 2026-11-04. Render changes its
limits, so check them again before relying on them.

---

## The setup

| Part | Where | Notes |
| --- | --- | --- |
| Game server | Render free web service | One instance, as [ADR 0010](adr/0010-break-freely-one-instance.md) requires |
| Client | Render static site | Free, but counts towards the same bandwidth and build minutes |
| Database | Neon free tier | **Not** Render's free Postgres, which expires after 30 days and is deleted 14 days later |
| Keep-awake ping | An external uptime monitor | `GET /health` every 10 minutes |

**Server**

- Build: `npm ci && npm run build`
- Start: `npm run start --workspace @lms/server`
- `NODE_VERSION=22`: the start script uses `--env-file-if-exists`, which needs 22.9 or newer.
- `WS_PORT` set to the same value as Render's `PORT` (10000 by default). The server
  reads `WS_PORT`, and serves HTTP and WebSockets on that one port.
- `NODE_ENV=production`, `DATABASE_URL`, `ALLOWED_ORIGINS` (the client's URL), and the
  chain and key variables from [.env.example](../.env.example).

**Client**

- Build: `npm ci && npm run build && npm run build --workspace @lms/client`
- Publish directory: `packages/client/dist`
- `VITE_WS_URL=wss://<the server's host>`, set at build time.

**The ping** has to come from outside Render, because a service that has spun down
cannot wake itself. Scheduled GitHub Actions can run late, which is a poor fit for a
15-minute limit. Render's free-tier page says nothing about keep-alive pings either way,
so read its terms before relying on this.

---

## What survives the server going down

The money is on the chain, not on Render. With the server down, players can still
`withdraw`, `dispute` and `finalize`, anyone can `cancelMatch` once a deadline has
passed, and the guardian can still `pause` and `veto`. These all work from a block
explorer. What stops is play, and everything that depends on the keeper or on
`GET /transcripts/<hash>`.

---

## The risks

### Restarts

Render "might restart a Free web service at any time".

- **Staked matches** resume from their Postgres journal, in the same round with the same
  rolls, after a new ready phase for players to reconnect
  ([ARCHITECTURE.md](ARCHITECTURE.md), "Restarts"). A match that cannot replay is
  aborted and refunded.
- **Practice matches** are lost.
- **Every player** is disconnected and has to reconnect. A restart in the middle of a
  match will be noticed, and could appear in a live demo or a recording.
- **The matchmaking queue and rate limits** live in memory, so they reset.

### Spin-down, if the ping fails

After 15 minutes without inbound traffic the service stops. The next request wakes it,
which takes about a minute. It then behaves like a restart.

While it is asleep the keeper is asleep too, so lobbies do not lock, results are not
submitted and fees are not harvested. Nothing wakes the server on a chain event. A match
left that way is refunded through `cancelMatch` after its 1-hour settlement deadline,
which someone has to call.

The monitor is a single point of failure, so turn on its down alerts.

### Instance hours: only one server can stay awake

Each workspace gets **750 free instance hours a month**, and one always-on server uses
up to 744. When the hours run out, **every free web service in the workspace is suspended
until the next month.**

The server handles one hub chain, so testnet and mainnet need a server each, and they
cannot both be kept awake. The second gets only the 6 to 30 hours left over, and an
idle spun-down service uses none. Testnet and mainnet also need **separate databases**,
because a second server on the same database is refused at start.

### Disk

Not a problem as long as `DATABASE_URL` is set. Render's disk is wiped on every restart,
but the server writes nothing to local files: archives, journals and play styles all go
to Postgres.

**Never run the public server with `ARCHIVE=memory`.** A restart would then lose the
journals and transcripts: staked matches would be aborted, and players could not audit
results already proposed.

### CPU and memory

Render's free-tier page does not state CPU or RAM. Third-party guides give 512 MB and
as little as 0.1 CPU, so check the dashboard.

The server is several Node processes on one instance: the main one, the attestor, a
signature verification pool and, if enabled, the analyst. The numbers in
[LOAD_TESTING.md](LOAD_TESTING.md) came from a developer machine and **do not apply
here.** Expect far fewer players, and possibly late rounds on a slow CPU. Running out of
memory is another restart. Before the demo, run a small load test against the deployed
server to find the real limit.

### Redeploys may fail on the instance lock: test this first

Render starts the new instance and moves traffic to it, and only then stops the old one.
The server takes a Postgres advisory lock at start and exits if another instance holds it
(`claimInstance` in `packages/server/src/db/database.ts`). So the new instance may refuse
to start because the old one is still running, and the old one will not stop until the new
one has started.

If that happens, either suspend the service before each deploy, which means downtime, or
change the server so it binds its port before claiming the lock. Render's docs do not say
whether free services use this deploy sequence.

### Neon's pooled connection string: test this too

[.env.example](../.env.example) recommends Neon's pooled connection string, but the lock
above is session-level, and session-level advisory locks are not reliable through a
transaction-mode pooler. The lock may not protect anything, or may outlive the instance
that took it and block the next start, which matters more when restarts are routine.
Test it, and use the direct connection string for the server if it misbehaves.

Also check how Neon's free tier behaves when idle, since the server stops if the database
is unreachable.

### Outbound traffic and bandwidth

- The server polls the chain constantly: every 4 seconds for the escrow and every 15 for
  proposals, plus cross-chain and fee polls. Render "may suspend" a free service that
  starts unusually high traffic to external APIs or databases, and a free RPC plan has
  limits of its own.
- With no payment method on the account, going over the included bandwidth suspends all
  free services for the rest of the month. With one, it costs money.

### Keys

`ATTESTOR_PK`, `KEEPER_PK`, `SESSION_RELAYER_PK` and `MATCHMAKER_PK` all sit in one
service's environment. Anyone with access to the Render account can read them. Whoever
holds the attestor key can sign results, leaving only the guardian's veto, inside a
1-hour window that nobody is watching yet ([TODO.md](TODO.md), 3.1).

Keep the keeper and relayer funded with little more than gas, use a strong login with
two-factor on the Render account, and keep the Safe and guardian keys off Render entirely.

### Other limits

Free services have no shell access and no one-off jobs, so debugging is through logs
alone. Rollback only reaches the two most recent deploys.

---

## What this means for mainnet

These risks are acceptable only because nobody is meant to have real money at stake.
Hosting is not what makes the mainnet demo safe: the limits in
[TODO.md](TODO.md), section 8, are. If other people's money is ever really involved,
move to a paid instance first, along with everything else section 5 lists.
