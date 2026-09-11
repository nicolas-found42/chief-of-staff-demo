# Person Research Benchmark — incumbent versus expanded

Baseline `7aa090c5424ab6c3` versus candidate `8ebc59982210a118`: **not-comparable**.

Not comparable: Candidate evaluation is incomplete or lacks explicit assessment evidence; planning provider: absent → openrouter; planning model: absent → inception/mercury-2.5-preview; research setting providers: 25 pre-expansion providers → full bundle; research setting mergedLimit: 24 → 60; research setting readers: html, text → html, text, documents, feeds, captions, social, records; research setting planner: false → true; research setting readConcurrency: 1 → 4; research setting leadPolicy: surpassed backlog retired beyond the selection margin; planner not configured → surpassed backlog retired beyond the selection margin; yield/latency ranking; planner explores unchanged evidence/coverage up to quietRounds times; research setting reconstruction: Configured reconstruction of the pre-#228 pipeline, not the pre-#228 binary; identity, extraction prompt/binding selection and per-source retry behavior are today's in both arms. → absent; research setting profileCalls: 12 → 180; research setting profileMilliseconds: 120000 → 900000; research setting gitSha: 273dc99bfb54775a71485df0c367317fd5322a4f → e4eb962993c40a8942913f6c82d7d859287a33fe; research setting extractionParts: absent → at most four 16k parts (60k total); longer sources retain opening context plus ranked 15k windows with original offsets; research setting smallCallCeiling: absent → 120s absolute ceiling on discovery, extraction-part and planning calls; research setting bindingRecovery: absent → an answer that fails to parse under response_format steps the binding down; the planner prefers forced tool calls; support/usefulness assessment: completed 30 → completed 29, failed 1.

## Research outcomes

| Run | Status | Completed | Bounded | Interrupted |
| --- | --- | --- | --- | --- |
| baseline | failed | 27 | 3 | 0 |
| candidate | failed | 28 | 2 | 0 |

Previously completed research now bounded or interrupted: hilary-cottam.

## Conditions that differed

- Candidate evaluation is incomplete or lacks explicit assessment evidence
- planning provider: absent → openrouter
- planning model: absent → inception/mercury-2.5-preview
- research setting providers: 25 pre-expansion providers → full bundle
- research setting mergedLimit: 24 → 60
- research setting readers: html, text → html, text, documents, feeds, captions, social, records
- research setting planner: false → true
- research setting readConcurrency: 1 → 4
- research setting leadPolicy: surpassed backlog retired beyond the selection margin; planner not configured → surpassed backlog retired beyond the selection margin; yield/latency ranking; planner explores unchanged evidence/coverage up to quietRounds times
- research setting reconstruction: Configured reconstruction of the pre-#228 pipeline, not the pre-#228 binary; identity, extraction prompt/binding selection and per-source retry behavior are today's in both arms. → absent
- research setting profileCalls: 12 → 180
- research setting profileMilliseconds: 120000 → 900000
- research setting gitSha: 273dc99bfb54775a71485df0c367317fd5322a4f → e4eb962993c40a8942913f6c82d7d859287a33fe
- research setting extractionParts: absent → at most four 16k parts (60k total); longer sources retain opening context plus ranked 15k windows with original offsets
- research setting smallCallCeiling: absent → 120s absolute ceiling on discovery, extraction-part and planning calls
- research setting bindingRecovery: absent → an answer that fails to parse under response_format steps the binding down; the planner prefers forced tool calls
- support/usefulness assessment: completed 30 → completed 29, failed 1

## Per person

| Person | Facts | Baseline recovered | Candidate recovered | Baseline research | Candidate research | New critical | New wrong-person | New overclaims |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| achim-steiner | 4 | 1 | 0 | completed | completed | 0 | 0 | 8 |
| ana-botin | 13 | 0 | 0 | completed | completed | 0 | 0 | 2 |
| anders-danielsson | 8 | 0 | 0 | completed | completed | 0 | 1 | 2 |
| arvind-krishna | 8 | 1 | 1 | bounded | completed | 0 | 6 | 10 |
| bong-joon-ho | 7 | 0 | 2 | bounded | bounded | 0 | 0 | 8 |
| cary-fowler | 10 | 0 | 0 | completed | completed | 0 | 0 | 0 |
| chimamanda-ngozi-adichie | 8 | 0 | 2 | bounded | completed | 0 | 0 | 6 |
| cristiano-amon | 7 | 0 | 2 | completed | completed | 0 | 1 | 9 |
| devi-shetty | 12 | 1 | 1 | completed | completed | 0 | 0 | 0 |
| doug-mcmillon | 8 | 0 | unmeasured | completed | completed | 0 | 0 | 0 |
| hilary-cottam | 5 | 0 | 0 | completed | bounded | 0 | 3 | 5 |
| irene-tracey | 10 | 0 | 2 | completed | completed | 0 | 0 | 6 |
| jane-fraser | 13 | 0 | 3 | completed | completed | 0 | 0 | 5 |
| kristalina-georgieva | 10 | 0 | 0 | completed | completed | 0 | 0 | 5 |
| laurent-freixe | 9 | 0 | 2 | completed | completed | 0 | 0 | 3 |
| maria-ressa | 8 | 0 | 2 | completed | completed | 0 | 0 | 5 |
| mary-barra | 10 | 0 | 0 | completed | completed | 0 | 2 | 6 |
| mia-mottley | 6 | 0 | 1 | completed | completed | 0 | 0 | 2 |
| michelle-gass | 11 | 0 | 0 | completed | completed | 0 | 0 | 1 |
| minouche-shafik | 12 | 0 | 2 | completed | completed | 0 | 0 | 8 |
| ngozi-okonjo-iweala | 7 | 0 | 0 | completed | completed | 0 | 0 | 4 |
| ramon-laguarta | 9 | 0 | 0 | completed | completed | 0 | 2 | 3 |
| rodolphe-saade | 10 | 0 | 2 | completed | completed | 0 | 3 | 5 |
| sally-kornbluth | 13 | 0 | 2 | completed | completed | 0 | 0 | 0 |
| sebastien-bazin | 9 | 0 | 1 | completed | completed | 0 | 0 | 0 |
| sn-subrahmanyan | 9 | 0 | 0 | completed | completed | 0 | 0 | 1 |
| soumya-swaminathan | 11 | 0 | 0 | completed | completed | 0 | 0 | 1 |
| tedros-adhanom-ghebreyesus | 12 | 0 | 1 | completed | completed | 0 | 10 | 11 |
| timnit-gebru | 8 | 0 | 0 | completed | completed | 0 | 0 | 0 |
| xavier-huillard | 10 | 0 | 0 | completed | completed | 0 | 0 | 7 |

## Grouped comparison

The reports' labelled slices, joined on dimension and key, each side with its own denominator. A group one arm did not record stays `unmeasured` rather than zero.

| Dimension | Group | Baseline people | Candidate people | Baseline facts | Candidate facts | Baseline recovered | Candidate recovered | Baseline critical / overclaims | Candidate critical / overclaims |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| industry | agriculture | 3 | 3 | 28 | 28 | 0 | unmeasured | 0 / 0 | 0 / 6 |
| industry | construction | 3 | 3 | 27 | 27 | 0 | unmeasured | 0 / 1 | 0 / 10 |
| industry | education | 3 | 3 | 35 | 35 | 0 | unmeasured | 0 / 0 | 0 / 14 |
| industry | finance | 3 | 3 | 36 | 36 | 0 | unmeasured | 0 / 1 | 0 / 12 |
| industry | government | 4 | 4 | 22 | 22 | 1 | unmeasured | 0 / 3 | 0 / 19 |
| industry | healthcare | 3 | 3 | 35 | 35 | 1 | unmeasured | 0 / 2 | 0 / 12 |
| industry | manufacturing | 2 | 2 | 20 | 20 | 0 | unmeasured | 0 / 1 | 0 / 11 |
| industry | media | 3 | 3 | 23 | 23 | 0 | unmeasured | 0 / 6 | 0 / 19 |
| industry | retail | 3 | 3 | 28 | 28 | 0 | unmeasured | 0 / 5 | 0 / 1 |
| industry | technology | 3 | 3 | 23 | 23 | 1 | unmeasured | 0 / 2 | 0 / 19 |
| role | Administrator, United Nations Development Programme | 1 | 1 | 4 | 4 | 1 | unmeasured | 0 / 3 | 0 / 8 |
| role | Agriculturalist; co-founder of the Svalbard Global Seed Vault | 1 | 1 | 10 | 10 | 0 | unmeasured | 0 / 0 | 0 / 0 |
| role | Cardiac surgeon; founder and Chairman of Narayana Health | 1 | 1 | 12 | 12 | 1 | unmeasured | 0 / 2 | 0 / 0 |
| role | Chair and Chief Executive Officer, General Motors | 1 | 1 | 10 | 10 | 0 | unmeasured | 0 / 0 | 0 / 6 |
| role | Chairman and Chief Executive Officer, Accor | 1 | 1 | 9 | 9 | 0 | unmeasured | 0 / 0 | 0 / 0 |
| role | Chairman and Chief Executive Officer, CMA CGM | 1 | 1 | 10 | 10 | 0 | unmeasured | 0 / 1 | 0 / 5 |
| role | Chairman and Chief Executive Officer, IBM | 1 | 1 | 8 | 8 | 1 | unmeasured | 0 / 1 | 0 / 10 |
| role | Chairman and Chief Executive Officer, PepsiCo | 1 | 1 | 9 | 9 | 0 | unmeasured | 0 / 0 | 0 / 3 |
| role | Chairman and Chief Executive Officer, VINCI | 1 | 1 | 10 | 10 | 0 | unmeasured | 0 / 0 | 0 / 7 |
| role | Chairman and Managing Director, Larsen & Toubro | 1 | 1 | 9 | 9 | 0 | unmeasured | 0 / 0 | 0 / 1 |
| role | Chief Executive Officer, Citigroup | 1 | 1 | 13 | 13 | 0 | unmeasured | 0 / 0 | 0 / 5 |
| role | Computer scientist; founder and Executive Director of the Distributed AI Research Institute | 1 | 1 | 8 | 8 | 0 | unmeasured | 0 / 0 | 0 / 0 |
| role | Director-General, World Health Organization | 1 | 1 | 12 | 12 | 0 | unmeasured | 0 / 0 | 0 / 11 |
| role | Director-General, World Trade Organization | 1 | 1 | 7 | 7 | 0 | unmeasured | 0 / 0 | 0 / 4 |
| role | Economist; former President of Columbia University and Director of the London School of Economics | 1 | 1 | 12 | 12 | 0 | unmeasured | 0 / 0 | 0 / 8 |
| role | Executive Chair, Banco Santander | 1 | 1 | 13 | 13 | 0 | unmeasured | 0 / 1 | 0 / 2 |
| role | Film director and screenwriter | 1 | 1 | 7 | 7 | 0 | unmeasured | 0 / 3 | 0 / 8 |
| role | Former Chief Executive Officer, Nestlé | 1 | 1 | 9 | 9 | 0 | unmeasured | 0 / 0 | 0 / 3 |
| role | Journalist; co-founder and Chief Executive Officer of Rappler | 1 | 1 | 8 | 8 | 0 | unmeasured | 0 / 0 | 0 / 5 |
| role | Managing Director, International Monetary Fund | 1 | 1 | 10 | 10 | 0 | unmeasured | 0 / 0 | 0 / 5 |
| role | Novelist and essayist | 1 | 1 | 8 | 8 | 0 | unmeasured | 0 / 3 | 0 / 6 |
| role | Paediatrician and clinical scientist; former Chief Scientist of the World Health Organization | 1 | 1 | 11 | 11 | 0 | unmeasured | 0 / 0 | 0 / 1 |
| role | President and Chief Executive Officer, Levi Strauss & Co. | 1 | 1 | 11 | 11 | 0 | unmeasured | 0 / 0 | 0 / 1 |
| role | President and Chief Executive Officer, Qualcomm | 1 | 1 | 7 | 7 | 0 | unmeasured | 0 / 1 | 0 / 9 |
| role | President and Chief Executive Officer, Skanska | 1 | 1 | 8 | 8 | 0 | unmeasured | 0 / 1 | 0 / 2 |
| role | President and Chief Executive Officer, Walmart | 1 | 1 | 8 | 8 | 0 | unmeasured | 0 / 5 | 0 / 0 |
| role | President, Massachusetts Institute of Technology | 1 | 1 | 13 | 13 | 0 | unmeasured | 0 / 0 | 0 / 0 |
| role | Prime Minister of Barbados | 1 | 1 | 6 | 6 | 0 | unmeasured | 0 / 0 | 0 / 2 |
| role | Social entrepreneur and author; designer of public service models | 1 | 1 | 5 | 5 | 0 | unmeasured | 0 / 0 | 0 / 5 |
| role | Vice-Chancellor of the University of Oxford; neuroscientist | 1 | 1 | 10 | 10 | 0 | unmeasured | 0 / 0 | 0 / 6 |
| footprint | ambiguous | 4 | 4 | 40 | 40 | 1 | unmeasured | 0 / 2 | 0 / 18 |
| footprint | ordinary | 8 | 8 | 68 | 68 | 1 | unmeasured | 0 / 4 | 0 / 27 |
| footprint | records-first | 2 | 2 | 22 | 22 | 1 | unmeasured | 0 / 2 | 0 / 6 |
| footprint | rich | 11 | 11 | 108 | 108 | 0 | unmeasured | 0 / 12 | 0 / 55 |
| footprint | social-first | 1 | 1 | 8 | 8 | 0 | unmeasured | 0 / 0 | 0 / 0 |
| footprint | sparse | 2 | 2 | 16 | 16 | 0 | unmeasured | 0 / 1 | 0 / 12 |
| footprint | video-first | 2 | 2 | 15 | 15 | 0 | unmeasured | 0 / 0 | 0 / 5 |
| language | en | 23 | 23 | 211 | 211 | 3 | unmeasured | 0 / 15 | 0 / 96 |
| language | es | 1 | 1 | 13 | 13 | 0 | unmeasured | 0 / 1 | 0 / 2 |
| language | fr | 4 | 4 | 38 | 38 | 0 | unmeasured | 0 / 1 | 0 / 15 |
| language | ko | 1 | 1 | 7 | 7 | 0 | unmeasured | 0 / 3 | 0 / 8 |
| language | sv | 1 | 1 | 8 | 8 | 0 | unmeasured | 0 / 1 | 0 / 2 |
| region | Armonk, New York, United States | 1 | 1 | 8 | 8 | 1 | unmeasured | 0 / 1 | 0 / 10 |
| region | Bengaluru, India | 1 | 1 | 12 | 12 | 1 | unmeasured | 0 / 2 | 0 / 0 |
| region | Bentonville, Arkansas, United States | 1 | 1 | 8 | 8 | 0 | unmeasured | 0 / 5 | 0 / 0 |
| region | Bridgetown, Barbados | 1 | 1 | 6 | 6 | 0 | unmeasured | 0 / 0 | 0 / 2 |
| region | Cambridge, Massachusetts, United States | 1 | 1 | 13 | 13 | 0 | unmeasured | 0 / 0 | 0 / 0 |
| region | Chennai, India | 1 | 1 | 11 | 11 | 0 | unmeasured | 0 / 0 | 0 / 1 |
| region | Detroit, Michigan, United States | 1 | 1 | 10 | 10 | 0 | unmeasured | 0 / 0 | 0 / 6 |
| region | Geneva, Switzerland | 2 | 2 | 19 | 19 | 0 | unmeasured | 0 / 0 | 0 / 15 |
| region | Lagos, Nigeria | 1 | 1 | 8 | 8 | 0 | unmeasured | 0 / 3 | 0 / 6 |
| region | London, United Kingdom | 2 | 2 | 17 | 17 | 0 | unmeasured | 0 / 0 | 0 / 13 |
| region | Madrid, Spain | 1 | 1 | 13 | 13 | 0 | unmeasured | 0 / 1 | 0 / 2 |
| region | Manila, Philippines | 1 | 1 | 8 | 8 | 0 | unmeasured | 0 / 0 | 0 / 5 |
| region | Marseille, France | 1 | 1 | 10 | 10 | 0 | unmeasured | 0 / 1 | 0 / 5 |
| region | Menlo Park, California, United States | 1 | 1 | 8 | 8 | 0 | unmeasured | 0 / 0 | 0 / 0 |
| region | Mumbai, India | 1 | 1 | 9 | 9 | 0 | unmeasured | 0 / 0 | 0 / 1 |
| region | Nanterre, France | 1 | 1 | 10 | 10 | 0 | unmeasured | 0 / 0 | 0 / 7 |
| region | New York, United States | 2 | 2 | 17 | 17 | 1 | unmeasured | 0 / 3 | 0 / 13 |
| region | Oxford, United Kingdom | 1 | 1 | 10 | 10 | 0 | unmeasured | 0 / 0 | 0 / 6 |
| region | Paris, France | 1 | 1 | 9 | 9 | 0 | unmeasured | 0 / 0 | 0 / 0 |
| region | Purchase, New York, United States | 1 | 1 | 9 | 9 | 0 | unmeasured | 0 / 0 | 0 / 3 |
| region | San Diego, California, United States | 1 | 1 | 7 | 7 | 0 | unmeasured | 0 / 1 | 0 / 9 |
| region | San Francisco, California, United States | 1 | 1 | 11 | 11 | 0 | unmeasured | 0 / 0 | 0 / 1 |
| region | Seoul, South Korea | 1 | 1 | 7 | 7 | 0 | unmeasured | 0 / 3 | 0 / 8 |
| region | Stockholm, Sweden | 1 | 1 | 8 | 8 | 0 | unmeasured | 0 / 1 | 0 / 2 |
| region | Vevey, Switzerland | 1 | 1 | 9 | 9 | 0 | unmeasured | 0 / 0 | 0 / 3 |
| region | Washington, D.C., United States | 2 | 2 | 20 | 20 | 0 | unmeasured | 0 / 0 | 0 / 5 |
| reference-source-family | creative-records | 2 | 2 | 15 | 15 | 0 | unmeasured | 0 / 6 | 0 / 14 |
| reference-source-family | documents-publishers | 30 | 30 | 277 | 277 | 3 | unmeasured | 0 / 21 | 0 / 123 |
| reference-source-family | historical-evidence | 6 | 6 | 57 | 57 | 0 | unmeasured | 0 / 7 | 0 / 35 |
| reference-source-family | professional-records | 1 | 1 | 10 | 10 | 0 | unmeasured | 0 / 0 | 0 / 0 |
| reference-source-family | public-social | 5 | 5 | 42 | 42 | 1 | unmeasured | 0 / 2 | 0 / 25 |
| reference-source-family | published-work | 12 | 12 | 116 | 116 | 1 | unmeasured | 0 / 5 | 0 / 46 |
| reference-source-family | spoken-evidence | 10 | 10 | 102 | 102 | 1 | unmeasured | 0 / 2 | 0 / 35 |

## Recovery audit

Every credited positive recovery is checked against the reference text and the claim excerpt its own judgement names; a credit whose record cannot be checked, or whose rationale records a withheld verdict, is rejected and named rather than discounted quietly. The per-person and total recovery numbers read the audited credits.

| Run | Recorded credits | Audited credits | Rejected |
| --- | --- | --- | --- |
| baseline | 3 | 3 | none |
| candidate | 26 | 26 | none |

## Coverage gaps

Each report's own open-coverage totals: planned areas against the gaps they still name. A resumed run's totals cover the operations it re-ran, not the people it carried; a side that predates the fields stays `unmeasured`.

| Run | Planned areas | Areas with open gaps | Area gaps | Explicit gaps |
| --- | --- | --- | --- | --- |
| baseline | 510 | 493 | 493 | 607 |
| candidate | 85 | 66 | 131 | 135 |

## Failures

People whose recorded result carries a failure; research statuses stay in the research-outcomes table.

| Run | Person | Recorded failure |
| --- | --- | --- |
| baseline | arvind-krishna | Research bounded before the operation completed. |
| baseline | bong-joon-ho | Research bounded before the operation completed. |
| baseline | chimamanda-ngozi-adichie | Research bounded before the operation completed. |
| candidate | bong-joon-ho | Research bounded before the operation completed. |
| candidate | doug-mcmillon | Judge support/usefulness assessment failed: openrouter: a model call was in flight when the request ceiling fired (model z-ai/glm-5.3-flash, binding forced_tool_call, HTTP 200, 4925 bytes, ceiling 90000ms) |
| candidate | hilary-cottam | Research bounded before the operation completed. |

| Run | Research failure code | Attempts |
| --- | --- | --- |
| baseline | document-empty | 65 |
| baseline | discovery-empty | 34 |
| baseline | identity-unmatched | 11 |
| baseline | http-error | 8 |
| baseline | challenge-page | 6 |
| baseline | request-timeout | 6 |
| baseline | login-required | 4 |
| baseline | rate-limited | 3 |
| baseline | resource-unavailable | 3 |
| candidate | identity-unmatched | 2044 |
| candidate | document-empty | 598 |
| candidate | resource-unavailable | 221 |
| candidate | transcription-failed | 129 |
| candidate | http-error | 127 |
| candidate | captions-missing | 122 |
| candidate | transport-failed | 113 |
| candidate | dns-failed | 73 |
| candidate | challenge-page | 62 |
| candidate | request-timeout | 41 |
| candidate | unsupported-format | 41 |
| candidate | login-required | 36 |
| candidate | tls-failed | 21 |
| candidate | model-boundary-failed | 14 |
| candidate | parser-failed | 10 |
| candidate | publication-conflict | 8 |
| candidate | rate-limited | 6 |
| candidate | connectivity-failed | 1 |
| candidate | invalid-result-shape | 1 |

## Actual source-family contribution changes

Recovery follows actual cited sources; families overlap. Exclusive means the matched claim cites one family, not proven causal necessity. Unmeasured legacy contributions stay unknown.

| Family | Baseline retained / cited | Candidate retained / cited | Baseline recovered / exclusive | Candidate recovered / exclusive |
| --- | --- | --- | --- | --- |
| creative-records | 0 / 0 | 9 / 4 | 0 / 0 | unmeasured |
| documents-publishers | 133 / 62 | 703 / 332 | 3 / 3 | unmeasured |
| historical-evidence | 0 / 0 | 40 / 20 | 0 / 0 | unmeasured |
| identity-affiliation | 0 / 0 | 4 / 2 | 0 / 0 | unmeasured |
| public-social | 0 / 0 | 6 / 2 | 0 / 0 | unmeasured |
| published-work | 0 / 0 | 56 / 27 | 0 / 0 | unmeasured |
| spoken-evidence | 2 / 1 | 57 / 25 | 0 / 0 | unmeasured |

