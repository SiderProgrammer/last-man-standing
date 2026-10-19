# Match analyst

A post-match analysis written by Gemini: a short narrative, the key moments that
shaped the match, and advice for the player who asks. It streams into the match
sidebar over the game's own WebSocket, and each key moment replays its round in
the arena when clicked.

This page is the design: what it is allowed to touch, how an answer is produced
and checked, and what it costs to run.

## Out of consensus, by construction

The game's trust model rests on deterministic replay: anyone holding the seed
and the move log can recompute the history root the attestors signed. Nothing
the analyst produces may bend that, so it is kept out of every path that does:

- It reads **only the archive**, and a match reaches the archive in
  `Lobby.finalise`, after the result was computed, signed and submitted. A
  running room never sees the analyst.
- It **writes only its own cache** (`match_analyses`), keyed apart from the
  match rows. No room, engine, hash or settlement code imports it.
- The client renders it in its own tab. It changes no match state; clicking a
  moment rebuilds the table from the published history (`stateBeforeRound`)
  and replays a round the client already holds.

The worst a wrong analysis can do is be wrong, which is the next section's job.

## How an answer is produced

```
client                 gateway                analyst                         Gemini
  │ analyze{matchId} ──▶ │ ── analyze() ──────▶ │ archive → access → cache hit? │
  │                      │                      │ limits.admit()                │
  │                      │                      │ ── stream(tools, system) ───▶ │
  │ ◀── analysis.step ── │ ◀── onStep ───────── │ ◀── functionCall get_round(4) │
  │                      │                      │ ── functionResponse ────────▶ │
  │ ◀── analysis.delta ─ │ ◀── onDelta ──────── │ ◀── JSON text, streamed ───── │
  │                      │                      │ schema parse → verify claims  │
  │ ◀── analysis.done ── │ ◀── result ───────── │ cache, metrics, budget        │
```

1. **Access.** A wallet seated in the match may analyse it, written for its
   seat. Anyone may analyse a *staked* match — it was public while it ran — as a
   spectator. A practice match stays private to the player who practised.
2. **Cache.** Answers are stored per match, per seat (the advice differs) and
   per *version*: a digest of model, effort, turn cap, system prompt, tool
   definitions and output schema. Change any of them and old answers stop
   matching instead of being served stale. A second request for an analysis
   already being written waits for it rather than paying twice.
3. **Limits** (`AnalystLimits`) apply only to a fresh, paid call: a per-wallet
   hourly allowance (refunded when the provider, not the player, failed), a
   server-wide concurrency cap, and an estimated daily budget in dollars that
   stops fresh analyses until the next UTC day — the one number that bounds the
   bill however the others are tuned. All in memory: a restart forgives them.
4. **The model call.** `gemini-3.8-flash` by default — any Gemini 3 model or
   later, the first to combine structured output with function calling —
   with effort pinned explicitly (`medium`, sent as the thinking level) and the
   answer constrained to a JSON schema with structured output. `gemini.ts`
   speaks the REST API directly: no SDK, one `fetch` per turn.
5. **Tools.** `get_match`, `get_round(n)`, `get_reads(seat)` and
   `get_player_history(seat)` are bound by the server to the one match being
   analysed. None takes a match id or a wallet address, so neither the model nor
   anything a player types can reach another match or look up a stranger:
   `get_player_history` takes a *seat* for exactly that reason. Tool schemas
   are closed, and every call's arguments are re-validated with zod on arrival
   — they are model output — so a bad call goes back to the model as an error
   result instead of running.
6. **The loop** is written by hand, and the model is injected (`AnalystModel`,
   over the analyst's own provider-neutral message format in `model.ts`), so
   the network is not the analyst's concern: tests drive the whole loop with a
   scripted fake. Every tool result goes back in one message; assistant turns
   are echoed whole, thought signatures included; `max_tokens` and `refusal`
   end the analysis and a tool call cut off by either is never run; the last
   allowed turn switches tools off so the model has to answer. A wall-clock
   deadline covers the whole loop on top of the per-attempt timeout and
   retries.
7. **Streaming.** The answer is JSON, which is what makes it checkable, so the
   server pulls the `summary` field out of the JSON as it arrives
   (`JsonFieldStream`, linear-time, escape-aware) and forwards only the prose.
   `analysis.done` then carries the parsed answer, which replaces whatever was
   streamed; `analysis.error` tells the client to discard it.

## Checking the claims

Each key moment is a claim in a shape the history can judge — round, seat,
kind, target — plus one sentence for people. `verify.ts` checks the structured
part against the `RoundRecord`s, deterministically and without a model:

| kind | holds when |
| --- | --- |
| `attack` | the seat revealed an attack on `target` that round |
| `hit` | its attack on `target` has outcome `hit` |
| `parry` | `target`'s attack on the seat has outcome `parried` |
| `evade` | `target`'s attack on the seat has outcome `missed` |
| `defend` / `hide` | the seat revealed that action |
| `timeout` | the seat did not reveal |
| `eliminated` | the seat is in that round's eliminations |

The round must exist, the seat must have been alive at its start, and `target`
must be present exactly for the targeted kinds. Unsupported moments are
dropped and counted (`dropped` on the analysis, `analyst_moments_total` in
metrics), and a decisive round the match never reached becomes null. The
sentence attached to a moment is not checked; it is the one part left to the
reader's trust, and the panel says so.

## Follow-up questions

Under a finished analysis the player can ask about the match
(`analysis.ask` → `analysis.reply.delta`… → `analysis.reply`). The same model,
system prompt and tools answer, in prose rather than the analysis schema.

The question is the one piece of free text a player can put in front of the
model, so it is handled as untrusted input at every layer:

- **Only the question travels.** The conversation — the overview, the analysis
  as the analyst's own earlier answer, and earlier exchanges — is held by the
  server per wallet and match, so a client cannot forge what the analyst said
  or plant turns of its own.
- **Bounded.** The gateway refuses empty questions and anything over 500
  characters; `sanitizeQuestion` strips control characters, collapses blank
  runs and caps the length again before the text reaches a prompt.
- **Fenced.** It is wrapped in `<player_question>` tags with angle brackets
  escaped, so it cannot close its own tag. The frozen system prompt says what
  those tags hold and that nothing inside them can change the rules, the tools
  or the topic.
- **Operator voice stays with the operator.** The switch to answer mode is a
  mid-conversation `role: "system"` message after each question, not text the
  player could imitate. Gemini has no such role, so `gemini.ts` carries it in
  the system instruction — still the operator's channel, never the player's.
- **Scoped tools.** The tools are the same match-bound views; a question cannot
  make them read another match or another wallet.
- **Capped.** The last six exchanges are replayed with each question; twenty
  questions per wallet per match; a separate hourly allowance per wallet; the
  same concurrency cap and daily budget as analyses.

Earlier turns are replayed as plain text, never with thought signatures, so
dropping the oldest exchanges when the cap is reached cannot invalidate a
signature the model has to read back. Within the cap the conversation only
grows at the end, so each question's request extends the previous one's and
the cache keeps hitting.

## Prompt caching

Gemini caches implicitly: a request whose prefix matches a recent one is
billed at the cached rate for that prefix. The layout is built for it: the
tool definitions are constants in name order and the system prompt is frozen —
built once from constants, never interpolated with a match, a player or a
time — so both are byte-identical on every request from every player, and
everything per-match goes in the messages, which only grow at the end as the
tool loop runs. A test pins the prefix byte-for-byte across turns and across
matches. Gemini's `cachedContentTokenCount` is summed per analysis as cache
reads, logged, and exported as the prompt-cache hit rate.

## Operations

- **Unavailable by default.** No `GEMINI_API_KEY`, no analyst: the `hello`
  frame says so and the panel explains it before anyone clicks.
  `ANALYST_ENABLED=false` turns it off even with a key.
- **Demo mode.** `ANALYST_DEMO=true` runs the real pipeline — a tool turn, a
  streamed JSON answer, the schema check, the verifier — over a rule-based
  stand-in that needs no key and costs nothing. It plants one false claim so the
  verifier visibly drops it, and its prose says plainly that it is not a real
  model.
- **Translation.** `gemini.ts` is the only file that knows Gemini's wire
  format: effort becomes `thinkingLevel` (`xhigh` and `max` become `high`),
  the output schema becomes `responseJsonSchema` (in the subset Gemini
  accepts — `outputSchema()` drops string lengths, which the parser enforces
  anyway), and thought signatures ride back on the part that carried them.
  Busy, timed-out and dropped calls are retried with backoff, but only while
  nothing has streamed to the player.
- **Errors** reach the client as `analysis.error` with a code it can act on:
  `unavailable`, `not_found`, `forbidden`, `quota`, `busy`, `timeout`,
  `refused`, `failed`. Provider errors are classified by `ProviderError` kind,
  set from the HTTP status, never by message text; a credentials problem is
  logged for the operator and shown to the player only as "unavailable".
- **Metrics.** `/metrics` serves Prometheus text — requests by outcome, errors
  by code, tokens by kind, turns, tool calls, estimated cost at list prices
  (priced by the model that served each turn),
  verifier verdicts, a latency histogram. Set `METRICS_TOKEN` on anything
  public. `/health` adds the ratios: analysis-cache hit rate, prompt-cache hit
  rate, verifier drop rate, today's estimated spend.
- **Evals.** `npm run eval:analyst` — see the README. Opt-in, never part of
  `npm test`, and it refuses to spend without `--yes`.

## Files

```
packages/protocol/src/analysis.ts      wire types: KeyMoment, MatchAnalysis, error codes, question length
packages/protocol/src/game/reads.ts    the reads logic, shared by the client panel and get_reads
packages/server/src/analyst/
  analyst.ts    access, cache, limits, the tool loop, deadline, usage, follow-up conversations
  model.ts      the injected model interface and the analyst's message format
  gemini.ts     the Gemini model: request and reply translation over REST
  prompt.ts     the frozen system prompt, match rendering, question fencing
  tools.ts      tool definitions and their execution against one match
  schema.ts     the output schema, re-validated on arrival
  stream.ts     JsonFieldStream: the narrative out of streaming JSON
  verify.ts     the claim verifier
  limits.ts     per-wallet allowance, concurrency, daily budget
  metrics.ts    counters, Prometheus text, health ratios
  pricing.ts    list prices for the cost estimate
  demo.ts       the offline demo model
  reference.ts  deterministic bot matches for tests and evals
  evals.ts      the eval suite and its scoring
packages/client/src/screens/analysis.ts   the analysis tab
packages/client/src/game/rewind.ts        the table before a given round
scripts/analyst-eval.mjs                  the eval runner
```
