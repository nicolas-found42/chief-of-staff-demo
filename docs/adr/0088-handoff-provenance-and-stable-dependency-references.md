# Handoff details carry their provenance and dependencies name records

The Meeting Wizard Architecture Review (F10, MWR-046/047/048) found that some execution detail
already admitted where it came from — responsibility, completion criteria, missing inputs and
dependencies each carried `explicit`/`inferred` — while purpose, required inputs and every
obtain-by step were plain text, and a dependency named another obligation by title alone. The
settled resolution in [issue #347](https://github.com/nicolas-found42/chief-of-staff-demo/issues/347)
approves structured provenance for every requirement and suggestion, and stable reconciled
references for internal dependencies; the implementation is
[issue #359](https://github.com/nicolas-found42/chief-of-staff-demo/issues/359).

## A detail declares supported, suggested or unknown

Purpose, completion criteria, required inputs, missing-input information and each obtain-by
retrieval step are `HandoffDetail`: the text, a `provenance`, and the transcript occurrences a
supported claim stands on. A `supported` detail cites the quotes it rests on; a `suggested` one is
the extraction's own proposal and nobody agreed to it; `unknown` means nothing was recorded about
where it came from.

The Module grounds every occurrence against the retained transcript and relabels a claim whose
occurrences do not ground: a criterion, input or retrieval step asserted as supported without a
verifiable quote becomes `suggested` with no occurrences. Confidence cannot raise a detail's
provenance, and code — not the model — decides which word survives. A suggested retrieval step is
detail about a commitment, so it can never become a second Action Item or Task: nothing in the
extraction pipeline turns a detail into checked output.

This trades a stricter extraction for an honest reading: a method the note-taker proposed now reads
as a suggestion in the Meeting page and in the accepted Task snapshot, because both are one
projection of the same rows.

## Dependencies name an identity, not a title

A dependency keeps the transcript's own wording and condition, gains the same provenance treatment,
and states whether it names another proposal in the same extraction (`extracted`) or something
outside it (`external`). The model writes the claim; it never writes an identity.

The materialization resolves `extracted` dependencies against the entries it actually checked and
records one target per dependency: the named entry's stable output identity, or the honest reason
there is none — two entries sharing the wording, no entry matching, or a dependency naming its own
entry. `external` declarations are never resolved by title at all. The Tasks read boundary then
resolves an output identity to the Action Item and proposal revision it materialized as, follows a
reconciliation redirect while keeping the identity it originally named, and reports a chain that
points back at itself rather than looping. An older record's title strings are never resolved
against today's records: a name that meant one Action Item then may be a different one now.

Dependencies remain proposal and evidence lineage. They are not Task scheduling constraints, create
no Task dependency behaviour and no placeholder Task for an external target, which is exactly
ADR-0054's exclusion and stays that way.

## The map is immutable and travels with the publication

Each checked entry's resolved dependencies are recorded in the materialization mapping, derived
from the record it describes, and written into the revision manifest beside the output mappings.
The manifest is verified against itself: a dependency naming an entry that revision did not check
is an integrity failure, not a published reference. Nothing is a second lifecycle — the dependency
map is part of the publication #358 already prepares and verifies, and a re-materialization
recomputes exactly the same targets from the same checked bytes.

## The stored shape and what it costs

Handoffs gain version 2: purpose, criteria, inputs, missing inputs and dependencies in the shapes
above. A version-1 handoff — one stored before this change — is read through shared accessors and
never rewritten: its own labels are shown exactly as it wrote them, its unlabelled purpose and
inputs read as `unknown`, and its dependency names stay unresolved because nothing recorded an
identity for them. Reading never writes, existing ids are never rekeyed, and the entry key and
payload checksum of an already-materialized entry are unchanged: the checked payload's fields and
its canonical serialization are the same, so a replay of an older Run rematerializes the record it
already has.

**No Workspace stored format is added.** The canonical bundle stays format 3, no artifact moves and
no migration marker is written, so activation needs no quiesce and no restore: the change is
additive for new extractions and read-only for existing records. A mixed Workspace — version-1
records beside version-2 ones — reads, promotes and resolves exactly as either does alone, and the
affected-state tests cover that state in isolation rather than claiming a live migration.

Two consequences are stated rather than discovered:

- A build from before this change reads a format-3 bundle, but does not know the version-2 handoff:
  it renders a detail's text without its provenance and prints the purpose and inputs that are now
  objects as object text, which the review panel's purpose line refuses outright. Rolling back the
  application therefore needs a compatible reader or a verified backup, whose loss interval is the
  extractions materialized after it — not a data restore for a format change, because no format
  changed.
- The evidence a version-1 record never carried cannot be manufactured later. Legacy detail stays
  `unknown`, and an audit that wants support for it has to re-extract from a source copy.
