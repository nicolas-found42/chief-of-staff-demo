# Person Research Benchmark — live-discovery

Run `db8939daf4ad079e` · **failed** · 2 of 4 people had research or assessment failures; 0 collection scenarios had assessment failures. These failures remain recorded even when evaluation execution finished.
Evaluation execution: completed; 2 / 4 selected people fully assessed. Research failures remain reported separately.

## Conditions

| Field | Value |
| --- | --- |
| Corpus version | 14bca86ee0b97d28 |
| Pipeline | expanded |
| Research provider/model | openrouter · inception/mercury-2.5-preview |
| Planning provider/model | openrouter · inception/mercury-2.5-preview |
| Judge provider/model | openrouter · z-ai/glm-5.3-flash |
| Judge version | 2026-09-06.10 |
| Prompt version | 2026-09-06.4 |
| Network | live |
| Started | 2026-09-09T04:31:26.021Z |
| Finished | 2026-09-09T04:50:14.887Z |
| Research settings | scheduling=as-ready reads; 8 readers globally, 2 per host (1 after slow/failing reads); 4 model documents globally, sourceReuse=canonical Bing destinations; exact source versions coalesced per identity revision and operation, discoveryIntent=native ORCID name, known-organization ROR and artist-name queries; typed results, benchmarkQueues=independent bounded research and judge workers, rorDataVersion=network, providers=full bundle, mergedLimit=60, readers=html, text, documents, feeds, captions, social, records, planner=true, readConcurrency=4, leadPolicy=surpassed backlog retired beyond the selection margin; yield/latency ranking; planner explores unchanged evidence/coverage up to quietRounds times, extractionParts=at most four 16k parts (60k total); longer sources retain opening context plus ranked 15k windows with original offsets, smallCallCeiling=120s absolute ceiling on discovery, extraction-part and planning calls, bindingRecovery=an answer that fails to parse under response_format steps the binding down; the planner prefers forced tool calls, profileCalls=180, profileMilliseconds=900000, operationConcurrency=4, modelRetryPolicy=One same-binding idle/transport retry inside the original deadline; extraction, planning and benchmark judges, usageAccounting=Logical request text and returned answer characters; excludes retried wire payloads, judgeBindingPreference=forced_tool_call when model-declared; default otherwise, extractionBindingPreference=forced_tool_call when model-declared; default otherwise, extractionRouteSort=throughput, extractionRouteThroughputFloorTps=50, reasoningEffort=low, judgeReasoningEffort=high, reasoningExclude=true, routeRestPolicy=repetition_loop, answer_overrun, request_timeout, 429 http_error, absent-or-500-plus upstream_error, routeRestCooldownSeconds=900, routeRestMaxRoutes=8, gitSha=c9cf65d1a7f5b2a911d80bce3865b748d4ce60c5 |
| Measured usage | 2142431 input characters, 382318 output characters; tokens and cost unavailable from the model boundary |

## Not evaluated

- `bong-joon-ho`: Excluded by --limit.
- `cary-fowler`: Excluded by --limit.
- `chimamanda-ngozi-adichie`: Excluded by --limit.
- `cristiano-amon`: Excluded by --limit.
- `devi-shetty`: Excluded by --limit.
- `doug-mcmillon`: Excluded by --limit.
- `hilary-cottam`: Excluded by --limit.
- `irene-tracey`: Excluded by --limit.
- `jane-fraser`: Excluded by --limit.
- `kristalina-georgieva`: Excluded by --limit.
- `laurent-freixe`: Excluded by --limit.
- `maria-ressa`: Excluded by --limit.
- `mary-barra`: Excluded by --limit.
- `mia-mottley`: Excluded by --limit.
- `michelle-gass`: Excluded by --limit.
- `minouche-shafik`: Excluded by --limit.
- `ngozi-okonjo-iweala`: Excluded by --limit.
- `ramon-laguarta`: Excluded by --limit.
- `rodolphe-saade`: Excluded by --limit.
- `sally-kornbluth`: Excluded by --limit.
- `sebastien-bazin`: Excluded by --limit.
- `sn-subrahmanyan`: Excluded by --limit.
- `soumya-swaminathan`: Excluded by --limit.
- `tedros-adhanom-ghebreyesus`: Excluded by --limit.
- `timnit-gebru`: Excluded by --limit.
- `xavier-huillard`: Excluded by --limit.

## Per person

| Person | Industry | Footprint | Recovered / facts | Ambiguous | Support-failed | Critical | Overclaims | Claims | Sources | Families | Conclusion |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| achim-steiner | government | ordinary | 0 / 4 | 1 | 1 | 0 | 8 | 55 | 18 | 1 | completed |
| ana-botin | finance | rich | 2 / 13 | 0 | 0 | 0 | 2 | 90 | 44 | 3 | completed |
| anders-danielsson | construction | ambiguous | 0 / 8 | 0 | 0 | 0 | 0 | 26 | 24 | 1 | completed |
| arvind-krishna | technology | ambiguous | 0 / 8 | 5 | 5 | 0 | 0 | 187 | 78 | 3 | completed |

## Capability intersections (r18)

| Scenario | Expected recovered | Active / researched Profiles | Demonstrated / claimed only | Missing expected people | Additional matches for review |
| --- | --- | --- | --- | --- | --- |
| directing-and-screenwriting | 0 / 0 | 4 / 4 | 0 / 0 | none | none |

Query categories: directing + screenwriting. Observed active Workspace Profiles only. Unresearched people and missing private work prevent claims of global rarity, productivity, availability or access. Reference expectations are supported positives in this selected collection; other people are unassessed, not proven incapable. Additional matches require evidence review. A subset without an expected person does not assess reference recovery for this scenario.

The JSON report retains matched claim/work IDs and citation URLs, hashes and quotations. Collection recovery is separate from individual reference-fact counts.

## The four measures, kept separate

- **Factual reliability** — 360 of 360 citations verify against their retained source version; 0 critical integrity findings; 10 judged overclaims, of which 0 are wrong-person attributions.
- **Completeness** — 2 of 33 reference facts recovered, 7 partially, 6 left ambiguous for review, 6 of them withheld for an incomplete support/usefulness assessment rather than semantic ambiguity, 0 contradicted by the reference, and 18 still missing.
- **Absolute richness** — 358 published claims over 164 retained sources; reported beside completeness, never folded into it.
- **Meeting-preparation usefulness** — mean understanding 2.50 of 3 over 2 completed support/usefulness assessments, judged with cited evidence.
- **Operational reliability** — 4 of 4 operations reached their own completion conditions.

## By group (with denominators)

Reference-source-family groups are cohorts of people whose reference documents include that family; their whole-person recovery is not a production source contribution.

| Dimension | Group | People | Recovered / facts | Ambiguous | Support-failed | Critical | Overclaims |
| --- | --- | --- | --- | --- | --- | --- | --- |
| industry | construction | 1 | 0 / 8 | 0 | 0 | 0 | 0 |
| industry | finance | 1 | 2 / 13 | 0 | 0 | 0 | 2 |
| industry | government | 1 | 0 / 4 | 1 | 1 | 0 | 8 |
| industry | technology | 1 | 0 / 8 | 5 | 5 | 0 | 0 |
| role | Administrator, United Nations Development Programme | 1 | 0 / 4 | 1 | 1 | 0 | 8 |
| role | Chairman and Chief Executive Officer, IBM | 1 | 0 / 8 | 5 | 5 | 0 | 0 |
| role | Executive Chair, Banco Santander | 1 | 2 / 13 | 0 | 0 | 0 | 2 |
| role | President and Chief Executive Officer, Skanska | 1 | 0 / 8 | 0 | 0 | 0 | 0 |
| footprint | ambiguous | 2 | 0 / 16 | 5 | 5 | 0 | 0 |
| footprint | ordinary | 1 | 0 / 4 | 1 | 1 | 0 | 8 |
| footprint | rich | 1 | 2 / 13 | 0 | 0 | 0 | 2 |
| language | en | 2 | 0 / 12 | 6 | 6 | 0 | 8 |
| language | es | 1 | 2 / 13 | 0 | 0 | 0 | 2 |
| language | sv | 1 | 0 / 8 | 0 | 0 | 0 | 0 |
| region | Armonk, New York, United States | 1 | 0 / 8 | 5 | 5 | 0 | 0 |
| region | Madrid, Spain | 1 | 2 / 13 | 0 | 0 | 0 | 2 |
| region | New York, United States | 1 | 0 / 4 | 1 | 1 | 0 | 8 |
| region | Stockholm, Sweden | 1 | 0 / 8 | 0 | 0 | 0 | 0 |
| reference-source-family | documents-publishers | 4 | 2 / 33 | 6 | 6 | 0 | 10 |
| reference-source-family | historical-evidence | 1 | 2 / 13 | 0 | 0 | 0 | 2 |
| reference-source-family | public-social | 1 | 0 / 8 | 5 | 5 | 0 | 0 |

## Actual source-family contributions

These counts follow actual retained source versions and cited claims; multiple retained versions of one URL are not independent sources. Recovered facts exclude critical-invalid citations and judged overclaims; a faithfully recovered self-report remains a self-report. Exclusive recovery means the matched claim cites only that family, not that the family was causally necessary or independent of every other source. A fact may appear in multiple families; do not add family recovery totals.

| Person | Actual family | Retained / cited versions | Cited claims | Recovered / person's facts | Exclusive recovered |
| --- | --- | --- | --- | --- | --- |
| achim-steiner | documents-publishers | 18 / 8 | 55 | 0 / 4 | 0 |
| ana-botin | documents-publishers | 40 / 19 | 83 | 1 / 13 | 1 |
| ana-botin | historical-evidence | 2 / 1 | 4 | 0 / 13 | 0 |
| ana-botin | spoken-evidence | 2 / 1 | 3 | 0 / 13 | 0 |
| anders-danielsson | documents-publishers | 24 / 12 | 26 | 0 / 8 | 0 |
| arvind-krishna | documents-publishers | 63 / 30 | 169 | 0 / 8 | 0 |
| arvind-krishna | historical-evidence | 6 / 3 | 10 | 0 / 8 | 0 |
| arvind-krishna | spoken-evidence | 9 / 3 | 8 | 0 / 8 | 0 |

The JSON report retains each contributing source URL, hash, upstream index, cited claim IDs and recovered reference-fact IDs, including retained sources that contributed no claims.

## Identity anchors

Retained identity and affiliation registry records (issue #252): the anchor that establishes an identifier belongs to this person, traced to the upstream index and the record's own version. Registry membership on its own does not attribute a linked work or activity to the person; a cited anchor means a claim actually rests on it, not that every fact about the person came from it.

| Person | Source | Upstream index | Source version | Cited |
| --- | --- | --- | --- | --- |
| — | no identity or affiliation registry record retained in this report | — | — | — |

## Observed judge wire attempts

| Assessment | Wire attempts observed | Recovery attempts initiated | Final failed attempts |
| --- | --- | --- | --- |
| Individual people | 15 | 5 | 3 |
| Collection scenarios | 0 | 0 | 0 |

The JSON retains correlated, sanitized attempt diagnostics even when a later attempt succeeds. These are observed wire attempts, separate from logical model invocations; uninstrumented boundaries do not supply wire counts. Character usage measures logical request text and returned answers, excluding retried wire payloads.

## Incomplete judge phases

| Person | Reference phase | Support/usefulness phase | Failure |
| --- | --- | --- | --- |
| achim-steiner | completed | failed | Judge support findings named unknown claims or statements that are not verbatim excerpts of their named claims, or invalid citation selections. |
| arvind-krishna | completed | failed | Judge support/usefulness assessment failed: openrouter: a model call was in flight when the request ceiling fired (model z-ai/glm-5.3-flash, binding forced_tool_call, HTTP 200, 5325 bytes, ceiling 90000ms) |

Completed reference-stage verdicts and matched evidence remain in assessment.phases.reference.judgements in the JSON/person artifacts. They are provisional; incomplete support assessment receives no positive recovery credit.

## Failures by reason code

| Code | Attempts |
| --- | --- |
| identity-unmatched | 463 |
| document-empty | 152 |
| resource-unavailable | 50 |
| transport-failed | 49 |
| http-error | 32 |
| challenge-page | 23 |
| rate-limited | 21 |
| dns-failed | 21 |
| request-timeout | 5 |
| login-required | 4 |
| model-boundary-failed | 4 |
| publication-conflict | 3 |
| tls-failed | 3 |
| captions-missing | 2 |
| connectivity-failed | 2 |

## Remaining misses

These are the acceptance targets for follow-up source and extraction work. A miss marked `beyond-current-coverage` was authored knowing the application cannot reach it today; it stays in the reference.

| Person | Fact | Requirements | Acquisition | Why it is still missing |
| --- | --- | --- | --- | --- |
| achim-steiner | Steiner completed two terms as UNDP administrator in June 2025; this is a historical role. | Dated history of problem areas and focus; Per-section freshness and explicit gaps | app-supported | ambiguous: Original semantic verdict: partial; downgraded to ambiguous because the matched claim has a validated overclaim finding, including findings requiring review; support/usefulness assessment did not complete; positive recovery credit is withheld. The dossier states Steiner served as UNDP Adm |
| achim-steiner | Erik Solheim was announced as Steiner’s successor at UNEP in May 2016, to take over in June. | Work followed after departure; Counterparties, relation type, shared work and dates | app-supported | missing: No dossier claim mentions Erik Solheim or his announcement as Steiner's successor at UNEP in May 2016; the dossier only covers Steiner's own UNEP leadership (2006-2016). |
| achim-steiner | In November 2018 Guterres appointed Steiner and Maria Ramos to co-chair the UN Task Force on Digital Financing of Sustainable Development Goals. | Dated governance, funding and advisory ties; Counterparties, relation type, shared work and dates; Individually dated domain crossings | app-supported | missing: No dossier claim mentions the UN Task Force on Digital Financing of Sustainable Development Goals, Maria Ramos, or a November 2018 appointment by Guterres. |
| achim-steiner | After leaving UNDP in 2025, Steiner returned to Oxford and established the Security Futures Lab around interconnected security risks. | Dated history of problem areas and focus; Writing and thinking separated from building | app-supported | missing: No dossier claim mentions a Security Futures Lab or the establishment of such a lab after leaving UNDP. The dossier only notes his return to Oxford (e.g., Senior Fellow of the Oxford Martin School in January 2026), which does not state the reference fact. |
| ana-botin | Ana Botín has been executive chairman of Santander Group since September 2014, the fourth generation of her family to hold the role. | Dated history of problem areas and focus; Deciding, recommending and executing distinguished | app-supported | partial: The dossier states she became Executive Chair of Banco Santander in September 2014 (also 'La banquera asumió la presidencia del Santander el 10 de septiembre de 2014'), matching the core appointment, but it never states she is the fourth generation of her family to hold the role — it only s |
| ana-botin | She was chief executive of Santander UK from November 2010 until she took the group chairmanship, succeeding António Horta Osório. | Dated history of problem areas and focus; Deciding, recommending and executing distinguished | app-supported | partial: The dossier states she was CEO of Santander UK in 2010 and that she led the UK subsidiary until taking the chairmanship ('hasta esa fecha había dirigido la filial en Reino Unido'), but it gives no November 2010 start date and never mentions her succeeding António Horta Osório. |
| ana-botin | She was executive chairman of Banesto, a Santander Group bank, from February 2002 to November 2010. | Dated history of problem areas and focus; Deciding, recommending and executing distinguished | app-supported | partial: The dossier places her at Banesto in 2002 but as Chief Executive rather than executive chairman, and it gives neither the February 2002 start date nor the November 2010 end date. |
| ana-botin | She was involved in Santander's 1997 acquisition of a 51 percent stake in Banco Osorno y La Union, then the largest bank in Chile, for 495 million US dollars. | Personal contribution distinguished from team output; Sourced operating magnitudes with unit, scope and date; Deciding, recommending and executing distinguished | app-supported | missing: The dossier contains no statement about Santander's 1997 acquisition of a 51 percent stake in Banco Osorno y La Union, the largest bank in Chile, for 495 million US dollars. |
| ana-botin | She founded the venture capital fund Suala Capital in 2000 and withdrew from it in 2006. | Personal contribution distinguished from team output; Dated history of problem areas and focus; Unsuccessful work and postmortems | app-supported | missing: The dossier contains no statement about founding the venture capital fund Suala Capital in 2000 or withdrawing from it in 2006. |
| ana-botin | Since 2021 she has been president of the European Banking Federation, succeeding Jean Pierre Mustier and becoming the first woman to hold the post. | Dated governance, funding and advisory ties; Independent verifiers and the exact assertion verified | beyond-current-coverage | missing: Recorded only in the Spanish-language source. Research that reads only English-language pages misses it. |
| ana-botin | She was appointed a director of the Coca-Cola Company in 2013. | Dated governance, funding and advisory ties; Counterparties, relation type, shared work and dates | app-supported | partial: The dossier states she is a board member of the Coca-Cola Company but does not state that she was appointed in 2013. |
| ana-botin | She was educated at St Mary's School Ascot and graduated in economics from Bryn Mawr College in 1981. | Individually dated domain crossings | app-supported | partial: The dossier states she earned her economics degree from Bryn Mawr College in 1981, but it says nothing about her being educated at St Mary's School Ascot. |
| ana-botin | She holds an honorary Dame Commander of the Order of the British Empire, awarded in 2015. | Independent verifiers and the exact assertion verified | app-supported | missing: The dossier contains no statement about an honorary Dame Commander of the Order of the British Empire awarded in 2015. |
| ana-botin | On 18 February 2021 the European Banking Federation appointed Ana Botín-Sanz de Sautuola y O'Shea as its next President for a two-year term succeeding Jean Pierre Mustier; the announcement recaps her as Santander Executive Chairman since 2014 after leading Santander UK (2010-2014) and Banesto (2002- | Dated governance, funding and advisory ties | app-supported | missing: The dossier contains no statement about the European Banking Federation appointing her president on 18 February 2021 for a two-year term succeeding Jean Pierre Mustier, nor the career recap. |
| ana-botin | On 13 October 2022 the Institute of International Finance announced that Botín, an IIF board member since 2014, will become its next Chair from January 2023 — the first woman to chair the IIF board — succeeding Axel Weber. | Dated governance, funding and advisory ties | app-supported | partial: The dossier states she was appointed IIF Chair in 2023, but it omits the 13 October 2022 announcement, her IIF board membership since 2014, that she is the first woman to chair the IIF board, and that she succeeded Axel Weber. |
| anders-danielsson | Anders Danielsson took office as president and chief executive of Skanska on 1 January 2018. | Dated history of problem areas and focus; Deciding, recommending and executing distinguished | beyond-current-coverage | partial: Recorded only in the Swedish-language source; the English record for this name resolves to a different person. |
| anders-danielsson | Before becoming chief executive he was deputy chief executive responsible for Skanska's construction units in the United States and for its infrastructure development. | Dated history of problem areas and focus; Deciding, recommending and executing distinguished; Personal contribution distinguished from team output | beyond-current-coverage | missing: Swedish-language source only. |
| anders-danielsson | He was employed at Skanska in 1991 after graduating from the KTH Royal Institute of Technology. | Dated history of problem areas and focus; Individually dated domain crossings | beyond-current-coverage | missing: Swedish-language source only. |
| anders-danielsson | He became head of Skanska's Swedish business in 2008 and joined group management in 2013 with responsibility for the Nordics, the United Kingdom and the United States. | Dated history of problem areas and focus; Deciding, recommending and executing distinguished | beyond-current-coverage | missing: Swedish-language source only. |
| anders-danielsson | He has been chief executive of Skanska Norge and Skanska Sverige as well as deputy chief executive of Skanska AB. | Dated history of problem areas and focus; Deciding, recommending and executing distinguished | beyond-current-coverage | missing: Swedish-language source only. |
| anders-danielsson | Svenska Dagbladet's 2017 report on his appointment was headlined on his strong profitability focus, and a companion piece asked how Skanska would come through the crisis. | Writing and thinking separated from building; Claimed and demonstrated expertise in one taxonomy | beyond-current-coverage | missing: The cited articles are behind a Swedish newspaper's own access controls; the reference records the headlines the encyclopedia preserves. |
| anders-danielsson | Skanska reported revenue of 179 billion SEK and operating income of 7.2 billion SEK for 2025, with 27,000 employees and a 65% reduction in its own scope 1 and 2 CO2 emissions against 2015. | Sourced operating magnitudes with unit, scope and date; Documented constraint environments | app-supported | missing: The dossier contains no figures on Skanska's 2025 revenue, operating income, employee count, or CO2 emissions reduction. |
| anders-danielsson | Skanska was founded in 1887. | Dated history of problem areas and focus | app-supported | missing: No dossier statement mentions Skanska's founding in 1887. |
| arvind-krishna | Krishna became IBM CEO in April 2020 and chairman in January 2021. | Dated history of problem areas and focus; Per-section freshness and explicit gaps | app-supported | ambiguous: Original semantic verdict: recovered; downgraded to ambiguous because support/usefulness assessment did not complete; positive recovery credit is withheld. The dossier states both role transitions with exactly the dates the reference gives: CEO since April 2020 and chairman since January  |
| arvind-krishna | Krishna was a driving force behind IBM’s $34 billion Red Hat acquisition, which closed in July 2019; the transaction was IBM’s. | Personal contribution distinguished from team output; Sourced operating magnitudes with unit, scope and date; Counterparties, relation type, shared work and dates | app-supported | ambiguous: Original semantic verdict: partial; downgraded to ambiguous because support/usefulness assessment did not complete; positive recovery credit is withheld. The dossier states Krishna drove IBM's $34 billion Red Hat acquisition, but dates the transaction to the end of 2018 rather than the re |
| arvind-krishna | Krishna worked in Watson Research from 1990 to 2009 before general management and later senior research leadership. | Dated history of problem areas and focus; Individually dated domain crossings | app-supported | ambiguous: Original semantic verdict: recovered; downgraded to ambiguous because support/usefulness assessment did not complete; positive recovery credit is withheld. The dossier states the Watson Research tenure with the same start and end dates (1990–2009). The subsequent career progression in the |
| arvind-krishna | The retained biography credits Krishna with co-authoring 15 patents and editing IEEE and ACM journals; these are shared technical contributions. | Personal contribution distinguished from team output; Writing and thinking separated from building; Dated observed artifacts by kind | app-supported | ambiguous: Original semantic verdict: recovered; downgraded to ambiguous because support/usefulness assessment did not complete; positive recovery credit is withheld. The dossier states the same technical contributions: co-authorship of 15 patents and editorship of IEEE and ACM journals, with the sa |
| arvind-krishna | IBM’s biography lists board memberships at the New York Federal Reserve Bank, Northrop Grumman and the US-India Strategic Partnership Forum; these are employer-reported affiliations at retrieval. | Dated governance, funding and advisory ties; Source composition and single-source dependency | app-supported | ambiguous: Original semantic verdict: recovered; downgraded to ambiguous because support/usefulness assessment did not complete; positive recovery credit is withheld. The dossier lists exactly the three board memberships named in the reference: New York Federal Reserve Bank, Northrop Grumman, and th |
| arvind-krishna | In a public LinkedIn post dated 28 May 2026, IBM chairman and CEO Arvind Krishna announced Project Lightwell, a $5B IBM–Red Hat commitment to secure open-source software at AI scale through a clearinghouse model that identifies vulnerabilities and deploys validated patches, naming Bank of America, B | Dated history of problem areas and focus; Writing and thinking separated from building; Dated observed artifacts by kind | beyond-current-coverage | missing: No current collector reads public social timelines; this fact is a coverage target, not a currently acquirable source. (On LinkedIn specifically see docs/research/linkedin-reading-options.md.) |
| arvind-krishna | Independent practitioner Alain J. received the announcement the same day as a serious enterprise control, writing that Lightwell changes the supply-chain equation and calling it audit evidence and a defensible control. | Independent verifiers and the exact assertion verified; Third-party credit and acknowledgments; Source composition and single-source dependency | beyond-current-coverage | missing: No current collector reads public social timelines; this fact is a coverage target, not a currently acquirable source. (On LinkedIn specifically see docs/research/linkedin-reading-options.md.) |
| arvind-krishna | Krishna's Lightwell text circulates in two distinguishable forms: his 28 May 2026 original post, and Alain J.'s same-day LinkedIn reshare, which embeds Krishna's original beneath Alain's own commentary. The reshare does not make the announcement Alain's statement. | Source composition and single-source dependency; Dated observed artifacts by kind | beyond-current-coverage | missing: No current collector reads public social timelines; this fact is a coverage target, not a currently acquirable source. (On LinkedIn specifically see docs/research/linkedin-reading-options.md.) |

## Lead dispositions

| Disposition | Leads | Share |
| --- | --- | --- |
| rejected | 2131 | 79.7% |
| inaccessible | 279 | 10.4% |
| investigated | 262 | 9.8% |
| interrupted | 2 | 0.1% |

of 2674 leads the run's research operations recorded.

## Coverage gaps

68 planned coverage areas; 60 still name open gaps (60 in total), and the operations recorded 117 explicit remaining gaps.

