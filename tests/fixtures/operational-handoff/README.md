# September 9 operational handoff fixture

The source transcript and its derived files are private, ignored local inputs.
They are intentionally absent from a public checkout. Automated regressions use
synthetic data from `tests/src/helpers/operational-handoff.ts`; debug scripts that
reference this directory require the local source files.

Source: `/Users/Nicolas/Downloads/Found42-Stand-Up-Meeting-fff12776-8d43.json`.
The JSON is an unchanged local copy supplied by Nicolas for this evaluation.
SHA-256: `a99b4eacb6941326b5881243a8429e6f26a0e20b26daf3a5f29d0f2a0e12614d`.

`2026-09-09-found42-stand-up.md` preserves all 1,126 segments in source order,
with each original start/end offset, speaker name, and sentence. The original
JSON additionally retains speaker IDs. Offsets are elapsed recording positions,
not wall-clock times. The date is trusted user context; the timezone is unknown.
No timezone conversion or external enrichment was performed.

This fixture is separate from the established debrief-golden suite. It has no
scoring golden yet: audited expectations must be written from the transcript
before candidate evaluation. Existing golden thresholds have not changed.
