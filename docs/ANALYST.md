# Match analyst

A post-match analysis written by Gemini: a short narrative, the key moments that
shaped the match, and advice for the player who asks. It appears in the match
sidebar, and each key moment replays its round in the arena when clicked.

This page is the design: what it is allowed to touch, how an answer is produced
and checked, and what keeps it inside the provider's limits.

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

The worst a wrong analysis can do is be wrong, which the claim verifier keeps
to the prose.

## How an answer is produced

```
client                 gateway                analyst                         Gemini
  │ analyze{matchId} ──▶ │ ── analyze() ──────▶ │ archive → access → cache hit? │
  │                      │                      │ limits.admit()                │
  │ ◀── analysis.step ── │ ◀── onStep ───────── │ reserve slot → whole match ─▶ │
  │                      │                      │ ◀── JSON answer ───────────── │
  │ ◀── analysis.step ── │ ◀── onStep ───────── │ schema parse → verify claims  │
  │ ◀── analysis.done ── │ ◀── result ───────── │ cache, budget                 │
```

1. **Access.** A wallet seated in the match may analyse it, written for its
   seat. Anyone may analyse a *staked* match — it was public while it ran — as a
   spectator. A practice match stays private to the player who practised.
2. **Cache.** Answers are stored per match, per seat (the advice differs) and
   per *version*: a digest of model, effort, turn cap, system prompt, tool
   definitions and output schema. Change any of them and old answers stop
   matching instead of being served stale. A second request for an analysis
   already being written waits for it rather than paying twice.
3. **Limits.** See [Limits](#limits).
4. **One call.** The first message holds the whole match: an overview, every
   round in full, each seat's tendencies over the match and, when the server
   keeps them, each seat's record in earlier matches — a few thousand tokens
   even for eight seats. The model answers from it in a single call, with
   tools switched off (`ANALYST_MAX_TURNS=1`, the default). On the free tier
   that is the difference between one rationed, sometimes minute-long request
   and three or four of them.
5. **The model.** `gemini-3.8-flash` by default — any Gemini 3 model or
   later, the first to combine structured output with function calling — with
   effort pinned explicitly (`medium`, sent as the thinking level) and the
   answer constrained to a JSON schema. `gemini.ts` speaks the REST API
   directly: no SDK, one `generateContent` call per turn.
6. **Tools,** usable only when `ANALYST_MAX_TURNS` is above 1 (otherwise they are switched off). `get_match`, `get_round(n)`, `get_reads(seat)` and
   `get_player_history(seat)` are bound by the server to the one match being
   analysed. None takes a match id or a wallet address, so the model cannot
   reach another match or look up a stranger: `get_player_history` takes a
   *seat* for exactly that reason. Tool schemas are closed, and every call's
   arguments are re-validated with zod on arrival — they are model output — so
   a bad call goes back to the model as an error result instead of running.
7. **The loop** is written by hand, and the model is injected (`AnalystModel`,
   over the analyst's own provider-neutral message format in `model.ts`), so
   the network is not the analyst's concern: tests drive the whole loop with a
   scripted fake. Every tool result goes back in one message; assistant turns
   are echoed whole, thought signatures included; `max_tokens` and `refusal`
   end the analysis and a tool call cut off by either is never run; the last
   allowed turn switches tools off so the model has to answer. A wall-clock
   deadline (5 minutes) covers the whole loop on top of the per-call timeout
   (4 minutes) — long, because the free tier has been seen taking 100 seconds
   to answer a one-word prompt.
8. **Progress.** While it works the analyst reports what it is doing —
   reading the match, waiting for a rate-limit slot and for how long, any
   lookups, checking the claims — as `analysis.step` frames, and the panel
   lists them under an elapsed-time counter, so a slow call never looks like
   a hang.

## Checking the claims

Each key moment is a claim in a shape the history can judge — round, seat,
kind, target — plus one sentence for people. `verify.ts` checks the structured
part against the `RoundRecord`s, deterministically and without a model:

| kind | holds when |
| --- | --- |
| `strike` | the seat revealed a strike on `target` that round |
| `hit` | its strike on `target` has outcome `hit` |
| `charged-hit` | its strike on `target` has outcome `hit` and spent a Charge |
| `block` | `target`'s strike on the seat has outcome `guarded` |
| `guard` / `charge` | the seat revealed that action |
| `timeout` | the seat did not reveal |
| `eliminated` | the seat is in that round's eliminations |

The round must exist, the seat must have been alive at its start, and `target`
must be present exactly for the targeted kinds. Unsupported moments are
dropped, counted on the analysis (`dropped`) and logged, and a decisive round
the match never reached becomes null. The sentence attached to a moment is not
checked; it is the one part left to the reader's trust, and the panel says so.

## Limits

`AnalystLimits` holds two kinds of ceiling, all in memory — a restart forgives
them.

**Per analysis**, checked before anything is sent:

- a per-wallet hourly allowance (3 by default), refunded when the provider,
  not the player, made the analysis fail;
- one analysis in flight server-wide, so it has the whole per-minute quota;
- an estimated daily budget in dollars at list prices (`pricing.ts`), the
  operator's circuit breaker once billing is on.

**Per model request**, the Gemini project's own rate limits, enforced here so
they are never met as errors. The defaults are the free tier for Gemini 3.8
Flash — **5 requests a minute, 20 a day** (`ANALYST_RPM`, `ANALYST_RPD`;
`none` lifts either). Every turn books a slot first: over the minute's
allowance it waits for one, past the day's it is refused. An analysis only
starts if the day still has room for all of its turns, so one is never
abandoned halfway, and the day turns at midnight Pacific time, when Gemini's
quota resets. At one call per analysis, the free tier allows about twenty
analyses a day. Tokens per minute (250K on the free tier) are not tracked: one
analysis uses well under 20K.

If Gemini answers 429 anyway — another client on the same key — the call is
not retried, since that is the quota talking; the player is told to try again
in a few minutes. Nor is a timeout: Gemini received the request and counts it,
so a retry would spend quota the limiter cannot see. Only 5xx and dropped
connections are retried, with backoff.

## Prompt caching

Gemini caches implicitly: a request whose prefix matches a recent one is
billed at the cached rate for that prefix. The layout is built for it: the
tool definitions are constants in name order and the system prompt is frozen —
built once from constants, never interpolated with a match, a player or a
time — so both are byte-identical on every request from every player, and
everything per-match goes in the messages, which only grow at the end as the
tool loop runs. A test pins the prefix byte-for-byte across turns and across
matches.

## Operations

- **Unavailable by default.** No `GEMINI_API_KEY`, no analyst: the `hello`
  frame says so and the panel explains it before anyone clicks.
  `ANALYST_ENABLED=false` turns it off even with a key.
- **Translation.** `gemini.ts` is the only file that knows Gemini's wire
  format: effort becomes `thinkingLevel` (`xhigh` and `max` become `high`),
  the output schema becomes `responseJsonSchema` in the subset Gemini accepts
  (`outputSchema()` drops string lengths, which the parser enforces anyway),
  and thought signatures ride back on the part that carried them.
- **Errors** reach the client as `analysis.error` with a code it can act on:
  `unavailable`, `not_found`, `forbidden`, `quota`, `busy`, `timeout`,
  `refused`, `failed`. Provider errors are classified by `ProviderError` kind,
  set from the HTTP status, never by message text; a credentials problem is
  logged for the operator and shown to the player only as "unavailable".
- **Visibility.** Each model call logs how it ended and how long it took;
  each fresh analysis logs one line — turns, tool calls, latency, tokens,
  estimated cost, moments kept and dropped — and each failure its code and
  reason. `/health` reports the model, today's model requests and today's
  estimated spend.

## Files

```
packages/api/src/analysis.ts           wire types: KeyMoment, MatchAnalysis, error codes
packages/server/src/analyst/
  analyst.ts    access, cache, limits, the tool loop, deadline, usage
  model.ts      the injected model interface and the analyst's message format
  gemini.ts     the Gemini model: request and reply translation over REST
  prompt.ts     the frozen system prompt and match rendering
  tools.ts      tool definitions and their execution against one match
  schema.ts     the output schema, re-validated on arrival
  verify.ts     the claim verifier
  limits.ts     per-wallet allowance, concurrency, daily budget, provider rate limits
  pricing.ts    list prices for the cost estimate
  reference.ts  deterministic bot matches for tests
packages/client/src/screens/analysis.ts   the analysis tab
packages/client/src/game/rewind.ts        the table before a given round
```
