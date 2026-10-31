# 0010 — Break freely; one server instance

**Status:** accepted, 2026-10-28 (Q22–Q24; migration by default 2026-10-29)

## Context

The review's fixes touch the wire protocol, contract storage and the database
schema. Keeping each change behaviour-preserving would mean shims, versioned
frames and migrations for data nobody has. Separately, rooms, rate limits and
the matchmaking queue live in one process's memory.

## Decision

- The wire protocol, storage layout and database schema **can all break**. The
  "behaviour-preserving" rule is dropped.
- Nothing is deployed with real users, so there is **no migration path**:
  fresh deploys only.
- **One server instance.** Rooms, the queue and rate limits stay local.

## Consequences

- Backward-compatibility shims are deleted rather than kept, and a new
  deployment starts from a clean registry and database.
- A second server against the same Postgres is refused at start (an advisory
  lock held for the server's life), so the limit is enforced, not just
  documented.
- Scaling out would need shared rooms, a shared queue and shared rate limits;
  that is a later decision, not this one.
