# Observability

How to see what the game server is doing: logs, metrics, traces, and the
cross-chain join monitor. Everything here is off the match's critical path —
a slow collector or a missing Prometheus never delays a round.

```bash
npm run obs:up      # Prometheus :9090, Grafana :3000, Jaeger :16686
METRICS_HOST=0.0.0.0 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  npm run dev --workspace @lms/server
```

Grafana opens on the provisioned **Last Man Standing — server** dashboard.

## Logs

`packages/server/src/observability/log.ts`. One event per line, context as
fields rather than spliced into the message:

```json
{"time":"…","level":"error","msg":"settlement failed","component":"lobby","matchId":"0xab…","error":"…","traceId":"…"}
```

- `LOG_FORMAT=json` (default with `NODE_ENV=production`) or `pretty`.
- `LOG_LEVEL=debug|info|warn|error`.
- `matchId` is the correlation id: filter on it to follow one match through the
  gateway, the room, the bridge and the relayer.
- `traceId`/`spanId` are added whenever a line is written inside a span, so a
  log line links to its trace.

Ship stdout with any collector (Vector, Promtail, the platform's own); nothing
in the server writes files.

## Metrics

`packages/server/src/observability/metrics.ts` defines every metric in one
place. `/metrics` is served on `METRICS_PORT` (9464), separate from the public
port and bound to loopback unless `METRICS_HOST` says otherwise.

| Area | Metrics |
| --- | --- |
| Gateway | `lms_ws_connections`, `lms_ws_authenticated`, `lms_ws_refused_total{reason}`, `lms_ws_closed_by_server_total{reason}`, `lms_ws_frames_total{type}`, `lms_ws_rejected_total{reason}`, `lms_ws_handle_seconds{type,outcome}`, `lms_logins_total{outcome}`, `lms_ws_heartbeat_terminated_total` |
| Rooms | `lms_rooms_active{kind}`, `lms_matches_started_total{kind}`, `lms_matches_finished_total{kind}`, `lms_rounds_resolved_total`, `lms_round_duration_seconds`, `lms_missed_moves_total{phase}`, `lms_lobby_tick_seconds`, `lms_replay_mismatch_total` |
| Chain | `lms_bridge_polls_total{outcome}`, `lms_bridge_poll_seconds`, `lms_bridge_last_success_timestamp_seconds`, `lms_bridge_block`, `lms_chain_tx_total{action,outcome}`, `lms_chain_tx_seconds{action}`, `lms_wallet_balance_wei{role}` |
| Cross-chain | `lms_crosschain_pending{origin}`, `lms_crosschain_stuck{origin}`, `lms_crosschain_delivered_total{origin,outcome}`, `lms_crosschain_delivery_seconds{origin}`, `lms_crosschain_orphans_total{origin}` |
| Process | `lms_nodejs_eventloop_lag_*`, heap, GC, handles, CPU (prom-client defaults) |

Labels are small closed sets. Match ids and addresses never become labels —
they would create a series per match — they live in logs and span attributes.

`lms_replay_mismatch_total` is a self-audit: every finished match is replayed
through the engine's independent `verifyResult` before it is signed. It must
stay at zero; it alerts rather than blocks, so a bug in the replay cannot
strand stakes by itself.

## Traces

`packages/server/src/observability/tracing.ts`. Code creates spans through
`@opentelemetry/api`, which is a no-op until `OTEL_EXPORTER_OTLP_ENDPOINT` is
set; then the SDK is loaded and spans go out over OTLP/HTTP.

Spans: `ws.<type>` for each client frame, `tx.<action>` for every transaction
the server sends (`settle`, `abort`, `lockMatch`, `finalize`, `cancelMatch`,
`relay`, `collect`, `harvest`), and `bridge.poll`. They carry `lms.match_id`
and `lms.address` attributes, so a trace backend can group a whole match
without one minutes-long trace.

## Cross-chain joins

`packages/server/src/chain/crossChain.ts`. A spoke join emits `JoinForwarded`
and sends the stake through the messenger; the hub must then emit
`PlayerJoined` (seated) or `JoinRefunded`. The monitor polls every spoke in
`SPOKES` and the hub, and pairs the two sides by `(matchId, player)`:

- **pending** — forwarded, not yet seen on the hub.
- **stuck** — pending longer than `CROSSCHAIN_STUCK_MS` (10 min). Logged once
  with the match and player, exported as `lms_crosschain_stuck`, and paged on.
  This is the "stake left the spoke and arrived nowhere" case from TODO §2.1.
- **orphan** — a hub seat claiming a watched spoke as origin that the spoke
  never forwarded: a misconfigured peer or a forged delivery.

Either side may be seen first, since the chains are polled independently.

## Alerts

`ops/observability/alerts.yml`. Paging: stuck or orphaned cross-chain joins,
replay mismatches, failing settlements, a stale bridge. Warning: low gas
wallets, event-loop lag, refused connections, missed-move spikes. The
thresholds are first guesses; tune them on real traffic.
