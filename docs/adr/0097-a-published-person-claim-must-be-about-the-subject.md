# A published Person Claim must be about the subject, not only grounded in a document that names them

Identity was decided per document and grounding per claim, and nothing asked
the question between them: is *this* claim about *this* person. A document that
mentions the subject once and otherwise describes a different named individual
satisfied both checks, so its claims published into the subject's Person
Profile with verbatim citations (#409).

The measured cost in the candidate arm of the acceptance comparison was 28
`wrong-person` Person Claims across 8 of 30 Benchmark People, against 21
overclaims of every kind in the incumbent arm. In one dossier
(`tedros-adhanom-ghebreyesus`) ten claims came from one retained Wikipedia
article about the choreographer Sherrie Silver, which names Tedros once and
names the World Health Organization because the two share it — name plus
employer, which `decideIdentity` reads as `matched`.

## The decision

A claim extracted from a document whose identity rests on a **name match
alone** is published only when the claim is about the subject. Two layers, both
deterministic, no second model call:

1. **The document's declared subject.** The opening of a document (its first
   1500 characters) is searched at line starts for the declaration shape a
   biographical or encyclopedic page states its subject in — a leading name
   followed by a copula. When that name is not the subject's, the document is
   about someone else. The title alone does not decide this: titles are site
   names, headlines and sections, and a subject read out of one would close the
   gate on documents that are about the subject after all.
2. **The claim's cited passage.** In such a document, a claim publishes only
   when the sentence carrying its citation names the subject — the full name or
   the family name, which is how running prose refers back to a person.

A withheld claim is recorded against the operation with the new
`off-subject-claim` diagnostic code and a reason, beside `identity-unmatched`
and `ambiguous-attribution`. It is never silently dropped.

The seam is `parsePartial` in `apps/server/src/person-profile/research.ts`,
which already admits claims one at a time and already drops the records that
depend on a dropped claim; `decideIdentity` now returns the kind of anchor its
decision rests on (`signal` or `name`) rather than only its strength.

## What is deliberately untouched

- **A document anchored by a signal** — the Profile's own profile URL, its
  email address, or a confirmed Workspace Transcript — never meets the gate.
  Such a document is the subject's own, and what it says is attributed as
  before.
- **Recall inside documents about the subject.** The per-claim test is the
  reason for layer 1: a document that really is about the subject describes
  them pronominally ("he was appointed Director-General"), and a per-claim name
  test applied everywhere would withhold exactly those claims. Layer 1 keeps
  the gate shut for those documents.

## Alternatives rejected

- **A check against `read.namedIndividuals`**, as issue #409's design note
  suggested. That field is populated only for professional and institutional
  records (`research-readers.ts`) and is undefined for every other route,
  including the Wikipedia article this failure was measured on.
- **A prompt-only correction.** `EXTRACTION_SYSTEM` already instructs the model
  to describe only the focal person, and the user payload already names them.
  The model produced these claims anyway.
- **Publishing off-subject claims at low match confidence.** A claim about a
  different individual is not a weaker claim about the subject; the dossier
  should not carry it at all.

## How it is verified

`tests/src/modules/person-research-subject-attribution.test.ts` drives
`PersonResearch.run` — the research/claims seam — for four cases: the fault,
the pronominal-recall guard, the signal-anchored document, and a replay against
the retained Sherrie Silver article committed under
`artifacts/person-benchmark/`, using the ten `wrong-person` claims the judge
recorded with their own quotes plus the two claims from that same document that
really are about Tedros. The replay withholds ten and publishes two.

The measurement that closes this — a re-run of the candidate arm against the
recorded baseline of 28 `wrong-person` overclaims — is live spend and needs the
owner's authorization under #405.
