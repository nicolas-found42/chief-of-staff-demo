# Researched Brief context is dated, and reconciliation is classified

The Meeting Brief now attaches dated provenance to every researched context item: when the app
retrieved it, the source's publication or as-of date where it states one, the stable identity of
the claim, and the evidence dates historical items carry. A freshness policy — seven days for
current role and company facts, 48 hours for news and conversation hooks, configurable, never
proof of truth — classifies each item as current, expired, historical, unknown or conflicting. A
missing date is unknown freshness, and historical relationship evidence keeps its event date:
reading an old claim today does not make it current.

Composition applies the policy the same way it already applies citation and guest validation. An
expired or contradicted current-role/company claim is defeated rather than asserted — the guest
section does not carry it as a current role, and the reason is named in the uncertainty a person
reads. Contradiction defeats a current assertion even inside its window, because two sources
disagreeing about the same claim is evidence about the claim, not about its age. An undated claim
is kept but disclosed as unknown freshness. Every item also lands in the immutable Brief as
`contextFreshness`, and the email, the in-app Brief and the measurement read model disclose it.

Delivery reconciliation is now a classified outcome rather than a nullable message. The Gmail
adapter answers `none`, `found`, `ambiguous` or `unreadable`; only `none` permits an outward
write. `ambiguous` (several messages carry the delivery identity) and `unreadable` (a candidate
could not be inspected) fail the deliver Stage retryably and never resend. The Daily and Weekly
Briefing emails, which share this adapter, follow the same rule.

Generation and delivery are measured separately on read, from artifacts and the append-only Run
timeline: counts by status, queue depth, delivery attempts, lost-ack convergences, and failures by
stage and classified code. No evidence text, provider payload or source URL enters the
measurement, and ordinary logs stay source-free; the evidence itself remains on the Run.

## Considered Options

- **Drop stale items entirely.** Rejected: the owner loses context that is still useful as
  history, and the Brief cannot say why it is absent. Defeating the current assertion and naming
  the date keeps the value and the honesty.
- **Treat a recent retrieval as freshness for every source.** Rejected: a Person Profile
  projection read today re-states research done weeks ago. Only a source that re-verifies at read
  time — a CRM lookup — may date a claim by its retrieval.
- **Treat several reconciliation matches as "already sent" and return.** Rejected as silent
  guessing: several messages may mean a real duplicate, and choosing one hides it. The refusal is
  visible, retryable and counted.
- **Count delivery failures from the delivery file.** Rejected: a later successful retry rewrites
  it. The append-only Run timeline keeps the failure counted after the recovery.

## Consequences

The freshness windows are operator configuration (`MEETING_BRIEF_CURRENT_ROLE_FRESHNESS_DAYS`,
`MEETING_BRIEF_NEWS_FRESHNESS_HOURS`) with the spec defaults; they tune sensitivity, not truth.
Stored formats gain only optional fields (`provenance` on enrichment sections, `contextFreshness`
on the Brief, retrieval dates on enrichment artifacts), so an older reader ignores them and an
older Run read by this code has no dated provenance and therefore unknown freshness — no
quiesce, migration or backup is required for this change. Human usefulness adjudication under the
frozen 12-case rubric remains an external prerequisite and is not claimed here.
