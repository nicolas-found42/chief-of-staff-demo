# Claim extraction gets its own model purpose

Issue #381 (Step 5, requested by the maintainer) asks for claim extraction
(C1) and dossier extraction (E1) to stop sharing one Settings purpose, so a
later stage-specific model trial can move one without moving the other. Both
call sites resolved through `personResearch` before this change; nothing
distinguished them in `configStore.getForPurpose`, so an override written for
one always followed the other.

`personProfileClaims` is added to `MODEL_PURPOSES` and to the per-provider
`models` override map, and `composePersonProfiles` now accepts an optional
`completeClaims` dependency, wired in `composeShell` to
`completeForPurpose("personProfileClaims")` and passed to
`createPersonClaimExtractor` in place of the shared `complete`. Every other
consumer of `PersonProfilesCompositionDeps` (the benchmark harness, the
composition tests) is unaffected: `completeClaims` defaults to `complete`
when absent, which is the same function claim extraction used before this
purpose existed.

The split has to change no resolved request on the day it lands — including
for a Workspace that already wrote a `personResearch` override before this
purpose existed. `ConfigStore.normalize` seeds each provider's
`personProfileClaims` from its `personResearch` value once, the first time it
is absent, and persists the result; a workspace with no override keeps
falling back to the same base model on both purposes, and a workspace that
already overrode `personResearch` keeps answering claim extraction with that
same model rather than silently reverting to the provider default the moment
the purposes split. The seed is written once and does not re-track
`personResearch` afterward — the mapping is a persisted starting point, not a
live fallback that would follow a later `personResearch` change and defeat
the whole point of separating the two purposes.

No model trial follows this change yet. R5 itself is gated on proving the
no-op before any model substitution, and R6 (a stage-specific model trial)
requires a paired live-model evaluation against the fixed acceptance pair
with an independent judge — real cost and a quality judgment call outside
what a code-only change can establish. That stays open, gated on the
maintainer choosing to run it through the existing benchmark rig.
