# LIVE-01 model-specific live validation — 2026-09-14

This is a newly owner-authorized evaluation using exactly `qwen/qwen3.7-flash`.
It is not evidence that the historical Solar prompt gate passed. The owner message
in this task supersedes the earlier absence of authorization and historical model,
balance-floor and price-cap assumptions for this campaign. It authorizes relevant
local source access, a bounded snapshot, provider transmission, live comparisons,
evaluation and scoped remediation. It does not supply third-party rights or human
judgments. No credits were purchased and no billing arrangements changed.

The campaign-specific grant, source inventory, criteria and detailed evidence are
private. The [owner-local evidence index](../../../../private-evidence/live-01-qwen-2026-09-14/README.md)
is outside this checkout and is not published by this document. In the commands
below, `PRIVATE_OUTPUT` denotes that evidence directory. Files under it include
source content and must not be copied into the repository or tracker.

## Frozen design and scope

Starting implementation: `86e95a96c3b01dd10c3d5d4f0d48486ced894acb`, clean.
GitHub Actions run `34882413817` completed successfully for that exact HEAD.
The selected existing corpus contains three internal meeting exports: sparse dated,
complex dated and undated. Existing references remain assistant-authored and are
not independently human-adjudicated. The private source inventory records original
paths and full byte hashes; no client workshop was selected and no recorded source
revocation was found in the selected fixture tree. Rights rely on this owner's
source-use authorization, not an invented public-domain designation.

Agent-selected criteria were written before dispatch: complete terminal-slot and
cost accounting; at least 90% required-obligation recall where applicable; zero
false actions, wrong responsibility/date assertions, wrong merges, false decisions
and unsupported handoff details. Each semantic category has its own denominator;
zero denominator is not applicable. Source meaning controls interpretation and
faithful combined steps are allowed. Golden keyword scores, model diagnostics and
human adjudication are separate evidence classes.

The exact model was available in OpenRouter's model and endpoint metadata. Alibaba
was the only listed provider and no ZDR endpoint was listed for this model. The new
model-specific grant records this route as non-ZDR; it neither borrows the historical
Nex exception nor claims zero retention. Every outbound model request is constrained
to the exact model, `order: ["alibaba"]`, `allow_fallbacks: false` and
`data_collection: "deny"`. A campaign transport fence rejects other origins,
model lists, model-routing fallbacks and altered provider policy before dispatch.
Its positive control and four negative controls contact no inference endpoint.

Metadata prices per million input/output tokens were $0.03/$0.13 below 32,000
prompt tokens, $0.10/$0.40 from 32,000, and $0.20/$0.80 from 256,000. Reservations
use the maximum verified tier conservatively; reported actual charges remain
separate from estimated/unverified failure charges. The agent selected a finite
$5 cumulative allowance, shared by all campaign work, with the existing $2
per-operation control. This is not an assertion that the owner supplied those
figures. Current metadata and the preflight balance are retained privately.

The public retrieval selection is three existing Cary Fowler corpus URLs:
Wikipedia, Open Library and TED. Source restrictions and attribution stay attached;
public accessibility is not represented as a blanket content licence. A fourth
case uses the HTTP form of the selected Wikipedia URL to exercise a real redirect.
The comparison covers prior HTTP, current guarded HTTP, ordinary Chromium and
sandboxed Chromium. It does not cover every source adapter, authenticated APIs,
non-GET document redirects, Calendar integration or universal timezone/DST behavior.

## Findings and scoped repairs

1. **Shared-ledger campaign collision.** Operation IDs contained the protocol and
   slot but not the campaign identity. A fresh campaign using the same durable
   ledger inherited the previous operation's charges and timeline. New operation
   IDs include the SHA-256 of the exact campaign ID; lossy filename slugification
   is deliberately avoided. The regression failed before the fix. Existing
   manifests and outcomes are preserved; affected measurements receive a separate
   time-bounded reconciliation, not rewritten historical evidence.
2. **Partial extraction counted as success.** Production correctly retains checked
   actions when a required section fails, but the harness discarded section
   availability and marked the result valid/successful. New artifacts retain
   section availability and partial content, set `valid: false`, and record a failed
   terminal slot when any required section is unresolved. The regression failed
   before the fix. No extraction prompt or production section policy changed.
3. **A no-recovery path still retried.** The OpenRouter branch clearing an exhausted
   provider list after HTTP 404 did not consult the caller's retry veto. It now
   respects that veto. A synthetic transport regression reproduced the observed
   path and proved no second wire request occurs; normal recovery remains covered
   by the existing provider suite. No different model or provider was introduced.

The original baseline's failures included upstream 429s and invalid candidate
accounting. A separately frozen paced repeat retained those failures and tested
request spacing. Provider error evidence identifies temporary upstream rate limits;
subsequent 404s can reflect the application's temporary exclusion of the sole
allowed provider. No route restriction was relaxed to obtain a passing result.

The live TED browser loss was reproduced and diagnosed: the sandboxed renderer hit
its 100-request limit with about 8.1 MB accepted resources. Ordinary Chromium
rendered the source; both HTTP collectors retrieved it. Retaining the safety ceiling
is justified: a browser compatibility loss is recorded rather than weakening
containment or declaring universal coverage. The production containment probe
passed all 14 groups, with zero forbidden-destination requests and one successful
unguarded positive control. HTTP-to-HTTPS document redirection succeeded in all
four arms. All three current/prior HTTP bodies were byte-identical in this sample.

## Reproduction and evidence ownership

The private `run.mts`, `paced-run.mts` and `fixed-run.mts` compose the repository's
real campaign planner, immutable manifest, extraction executor, admission service,
budget ledger and timeline. They use the existing explicit price-table injection
rather than changing unrelated global model-price defaults. The public campaign
CLI's static default table did not contain this model. Private freeze-support files
bind runner bytes, grant, criteria, full corpus revision, prompt/schema and provider
metadata. Existing output directories are immutable; use fresh campaign IDs and
roots when reproducing, and retain the same durable cumulative budget ledger.

```sh
pnpm exec tsx "$PRIVATE_OUTPUT/run.mts" --test-only
pnpm exec tsx "$PRIVATE_OUTPUT/run.mts"
pnpm exec tsx "$PRIVATE_OUTPUT/paced-run.mts"
pnpm exec tsx "$PRIVATE_OUTPUT/fixed-run.mts"
pnpm exec tsx "$PRIVATE_OUTPUT/identity.mts"
pnpm exec tsx "$PRIVATE_OUTPUT/semantic.mts"
```

These commands require the private snapshot and environment credential. No secret
belongs in the command line. The latter two use the same exact model and ledger;
model judging is explicitly a same-model diagnostic, never a human judgment.
The label-redacted review packet contains sources, references and retained outputs,
with its key stored separately. Because this is an explicitly single-model campaign,
omitting model labels cannot establish that the owner is unaware of the model.
No owner blind review has been fabricated.

## Final measured disposition

**The bounded campaign is complete; LIVE-01 acceptance failed and the finding remains
open.** Authorization, corpus access, credentials and model availability are no longer
the blockers. Every planned extraction slot has exactly one terminal outcome. No
historical manifest, failed outcome, output or source reference was rewritten to pass.

Full selected corpus revision:
`e0e40ee5782cda14d312920c7cbfd3b67be0468c55d6fe62d68ed5c5b34dab58`.
Grant identity: `live-01-qwen-20260914-owner-message`.

| Campaign | Terminal / planned | Complete extractions | Golden passes | Completion requests / HTTP attempts | Reconciled ledger charge |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original baseline | 3 / 3 | 0 | 0 / 3 | 12 / 17 | $0.028592531 |
| Paced follow-up | 3 / 3 | 0, after correcting the partial-result classification | 0 / 3 | 20 / 23 | $0.032413701 |
| Accounting/section-fix follow-up | 3 / 3 | 1 | 0 / 3 | 35 / 35 | $0.040397512 |

Charges in the table include conservative estimated/unverified failures; they are not
all actual billed cost. The paced run originally called one partial result successful
and reported cumulative earlier-operation charges. `reconciliation.json` preserves
those original fields beside corrected per-invocation totals. The final follow-up
has distinct budget operation identities and its outcomes reconcile directly.
Its successful-processing nearest-rank p95 is **387,177 ms**, based on just one
complete case; this is not a population latency estimate. Changed provider load,
request pacing and stochastic output prevent attributing completion differences to
the reporting fixes.

The final follow-up failed the complex case at `status-30` with a request timeout,
and the undated case at responsibility verification with invalid accounting. The
original undated verification returned **one of seven required dispositions**,
leaving six missing; that direct count is distinct from the older generic diagnostic's
"invalid items" field. Rejected model answers remain rejected; no reference or
acceptance threshold was weakened and no extraction prompt was tuned to this small sample.

Three helper slots also terminated: one public-record identity/extraction diagnostic,
one same-model semantic diagnostic, and one bounded identity quotation recheck.
The first identity check got all four support decisions and both extracted values
correct, but only **one of two** purported literal quotations matched the source.
The recheck requested minimal literal values and passed **four of four** support
decisions, both extracted values and **two of two** exact quotation checks. The
original failed grounding result remains retained. This is one author metadata
record, not full real-world entity disambiguation or a population benchmark.

The semantic diagnostic flagged **one unsupported handoff detail** in the complete
extraction. Its denominator covered one assessed detail, and it disagreed with the
reference's action categorization; no calibrated semantic error percentage or
independent quality verdict follows. These are same-model judgments, not human
judgments. The three-case owner review packet is prepared with one complete output
and two explicit failed-output cases, source text, existing references and unfilled
judgment templates. Model labels are absent; single-model knowledge and reference
fallibility remain disclosed. No owner review was performed or fabricated.

Across extraction and helpers there were **70 application completion requests and
78 HTTP attempts**, all specifying exactly `qwen/qwen3.7-flash` under the constrained
Alibaba policy. The eight extra attempts occurred on legacy exhausted-route recovery
before the retry-veto fix; they did not select another model or endpoint. There are
no active budget reservations. Provider-observed usage was **389,661 input tokens
and 302,231 output tokens**. Nine requests had estimated usage rather than observed
usage; their estimated input total was 129,642 tokens, and missing output usage is
not evidence of zero generation.

Final accounting:

- **$0.047474401 provider-reported cost** across observed successful requests.
- **$0.055419600 estimated/unverified failure charges**, retained conservatively.
- **$0.102894001 cumulative ledger charge**, against the agent-selected $5 allowance.
- Account-wide observed balance decrease: **$0.047474372**, consistent with the
  provider-reported subtotal within rounding. This observation does not establish
  exclusive account use and does not replace per-request accounting.

Final usage and inventory records are retained under the private index. No credits
were purchased, no account guardrail was changed, and no business Workspace
was activated, migrated or modified. New private diagnostic artifacts gained section
metadata; existing Workspace formats and historical artifacts were not migrated.

Implementation and verification are deliberately separated:

- The original and paced campaigns ran `86e95a96c3b01dd10c3d5d4f0d48486ced894acb`.
- The accounting/section-fix follow-up ran
  `80f66bf86b5e45f5a7d3e18846448c48b477bf42`.
- Final implementation and live helper calls used
  `67f59457a94513ffcda0885e50a0785edf32ca9d`, including the retry-veto fix. The exact
  404 failure branch is proven by its initially failing transport regression;
  the follow-up did not deliberately induce another live provider outage.
- At the final implementation, `pnpm run check` passed **3,109 tests in 266 files**
  plus typecheck, lint, 12 lint-policy probes, formatting, knip and workflow validation.
  `pnpm run test:e2e` built production output and passed **all 122 browser tests**.
  Local unit runs included the pre-existing optional retained-article replay; clean
  CI can skip that one test. Isolated Compose build, boot and health passed; the
  temporary containers/network were removed. The tested browser/HTTP modules are
  byte-identical between the containment/live-tested image and the final image.
- [PR #415](https://github.com/nicolas-found42/chief-of-staff-demo/pull/415) carries
  sanitized code, tests and this record. CI run **34886762389** passed the required
  `check`, `test`, `e2e` and `image` gates for the final implementation SHA above.
  Subsequent documentation-only delivery still requires green checks for its own
  head and squash merge with `--match-head-commit`.
  Automatic CodeRabbit review was disabled in the PR description using its
  [documented per-PR ignore command](https://docs.coderabbit.ai/reference/review-commands)
  to preserve the exact-model restriction; its status is not a model review claim.

There are **16 of 16 terminal public retrieval comparisons**, plus the separately
retained TED reproduction and 14-group containment probe. Three of three sources
remained accessible through HTTP; sandboxed browser rendering succeeded for two of
three. Public HTML working copies were reduced to bounded quotations after comparison,
retaining full-response hashes and byte counts. This respects the corpus's quotation
basis while limiting independent replay to retained excerpts and fresh retrieval.

The smallest remaining human step is source-based adjudication of the complete
output and the reference/diagnostic disagreement, using the prepared packet. Human
review alone cannot close LIVE-01: two selected cases still need complete extractions,
the bounded Golden gate did not pass, and the TED browser compatibility loss remains.
Further reliability or prompt work must retain this model-specific failure baseline
and produce new, separately frozen evidence. No general identity/extraction quality,
all-provider compatibility, Calendar or timezone/DST claim is made.
