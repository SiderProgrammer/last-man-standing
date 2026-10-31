# 0011 — Two match resolvers, pinned by golden transcripts

**Status:** accepted, 2026-10-29 (M22)

## Context

The engine resolves a match twice over: `Match`, the live state machine the
server runs, and `replay`, which recomputes a finished match from its seed and
move log for verification. The review flagged the duplication; merging them
would make the verifier depend on the code it is meant to check.

## Decision

Keep **two implementations**, and pin both with **frozen golden transcripts**:
recorded matches whose every round hash and history root are committed, which
both `Match` and `replay` must reproduce. The Solidity side checks the same
transcripts' hashes.

## Consequences

- A change to resolution that is meant to change results has to regenerate
  the transcripts (`npm run golden`), on purpose and in review.
- A change that drifts one implementation from the other fails a test instead
  of shipping a verifier that agrees with nothing.
- Two places to edit when the rules change; the transcripts make that cheap to
  get right.
