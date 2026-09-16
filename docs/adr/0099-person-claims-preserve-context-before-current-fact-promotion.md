# Person Claims preserve citation context before current-fact promotion

The Person Profile audit found that a verbatim token was enough to publish a
current fact even when the token occurred in several unrelated passages. The
owner approved a conservative deterministic publication safeguard: retain the
claim and its citations for inspection, but keep ambiguous fragments and
truncated past descriptions from establishing current facts. Lack of support
does not establish falsity. This complements ADR-0097's subject-attribution
check; it does not relax that check or replace it with lower confidence.

A retrieved LinkedIn profile matching the subject's own profile URL is
self-report regardless of the model's classification or the presence of a page
title. Repeated citation text and fragments without a recognized predicate
remain claimed, with a reason. The predicate recognizer is a conservative
English prose heuristic, not an entailment proof or a universal language
parser; recognizing a verb is not sufficient proof of truth. A truncated
passage describing the past cannot establish a current role or employer.
Identity match confidence still describes whose evidence this is.

Explicit neighboring fields in LinkedIn credential and organization sections
remain attached to their claims and verbatim citations. Credentials belong in
recognition as dated awards, not open-ended career roles; organizations stay
attached to titles. Place fragments belong in current context rather than
career background. Education dates, programme context, organizations and
credential issuers are in scope; follower counts are not. Missing institutions
remain unknown, never inferred from a nearby entry. Prompt guidance requests
these facts, but a controlled response cannot demonstrate live-model recall.

The authorized live verification still omitted these structured entries from
an otherwise valid reply. Publication therefore also preserves explicit
education date rows, credential/issuer/issue-date rows, and
organization/title/date rows on the subject's own LinkedIn URL when the reply
omits them. They remain self-reported claims with exact source spans, never
Profile fact updates. Absent institutions are labeled unknown; incomplete or
unrecognized structures stay in the retained source. Already covered spans
are not duplicated. This bounded recovery does not claim general recall of
unstructured prose and does not bypass failed or invalid extraction.

A headline combines researched role and employer only with a shared source and
known matching effective date. Their individual records remain inspectable.
Anonymous pages with repeated empty experience rows retain readable evidence
but disclose partial collection and the login limitation. No authenticated
retrieval or access-control workaround is introduced.

The tests use the production research path with controlled external responses,
fictional committed fixtures, and optional local replay of the immutable audit
pair. No stored schema changes or retrospective rewrites of existing dossiers
are authorized by this decision. The reader/extraction reuse key is advanced so
future work does not silently reuse parts under the prior processing policy.
