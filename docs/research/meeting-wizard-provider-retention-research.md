# Meeting Wizard provider routing and retention research

Research date: 2026-09-10. Scope: [Research OpenRouter transcript routing and retention controls](https://github.com/nicolas-found42/chief-of-staff-demo/issues/351), supporting MWR-051 and [Authorize transcript routes and retention boundaries](https://github.com/nicolas-found42/chief-of-staff-demo/issues/341).

This is a sequential primary-source research pass, without agents, paid inference, source uploads, account changes or provider contact. Public endpoint discovery is not evidence of which endpoint served a historical request. No private account configuration or source contents are recorded here. Research is complete within this scope; authorization and implementation remain separate decisions.

## Gateway and routing facts

OpenRouter documents two separate opt-ins: private input/output logging and use of inputs/outputs to improve its product. Both default off. It retains request metadata and samples prompts for anonymous categorization through a ZDR model. Thus “logging off” does not mean no processing other than the selected inference endpoint. Actual account opt-ins were not verified. [Data collection](https://openrouter.ai/docs/guides/privacy/data-collection).

The provider object supports `only`, `order`, `allow_fallbacks`, `data_collection` and `zdr`. Ordering or throughput sorting is not an authorization restriction. Endpoint-specific slugs matter: a base provider slug can match multiple variants. The routing documentation describes data-policy filtering as its best knowledge, not a definitive statement of third-party policy. [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

`provider.zdr: true` restricts requests to endpoints OpenRouter classifies as ZDR; account/guardrail enforcement cannot be disabled by the request. Endpoint-specific agreements can differ from provider-wide policies. OpenRouter classifies unknown policies conservatively. Its ZDR definition permits transient in-memory prompt caching. This is a declared routing policy, not independently audited storage behavior. [ZDR](https://openrouter.ai/docs/guides/features/zdr).

There is an internal documentation inconsistency: the Provider Logging page says retention does not affect routing, whereas the dedicated ZDR and provider-routing pages explicitly document ZDR filtering. Use the specific control documentation for the proposed implementation, and prove emitted request restrictions with controlled tests; do not infer the absence of controls from the older generic statement. [Provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging).

OpenRouter's current terms separately describe feature-dependent storage, anonymized input categorization, source rights, and limits on assurances about provider practices. This pass covers ordinary text Chat Completions; it does not authorize Files, batch, server tools, broadcast logging or other storage features. [Terms](https://openrouter.ai/terms/).

Its privacy policy, updated August 31, 2026, gives general business/legal retention language without one numeric lifetime for all metadata. Local deletion cannot be represented as deletion of gateway/upstream records. No remote deletion operation was performed or tested. [Privacy policy](https://openrouter.ai/privacy/).

## Public endpoint snapshot

Unauthenticated GETs on 2026-09-10 returned the following model routes. No transcript or account credential was sent. Re-fetch before dispatch; names, eligibility and policy declarations can change.

| Purpose | Model | Public endpoint tag | Listed by ZDR endpoint API? |
| --- | --- | --- | --- |
| Intended runtime | inception/mercury-2.5 | inception | Yes |
| Fixed Prompt Eval Gate | upstage/solar-pro4 | upstage/zdr | Yes |
| Same Solar model, other variant | upstage/solar-pro4 | upstage | No |

Sources: [Mercury endpoint API](https://openrouter.ai/api/v1/models/inception/mercury-2.5/endpoints), [Solar endpoint API](https://openrouter.ai/api/v1/models/upstage/solar-pro4/endpoints), [ZDR endpoint API](https://openrouter.ai/api/v1/endpoints/zdr). The endpoint labels returned model versions `mercury-2.5-20260908` and `solar-pro4-20260810`; these are discovery observations, not version pins in the application. Both ZDR entries reported implicit caching unsupported at inspection; the general ZDR policy nevertheless allows transient caching.

The provider-wide table calls Inception no-training/zero-retention and Upstage no-training/retaining prompts. The Solar endpoint distinction above explains why a provider-wide label cannot establish the policy for every route. [Provider table](https://openrouter.ai/providers).

## Upstream terms and uncertainty

Inception's general privacy policy covers personal data in prompts and includes training/refining models among service-improvement purposes. Retention is for necessary service/business purposes, with legal exceptions, without a numeric API retention commitment. This general document does not independently establish the narrower OpenRouter endpoint arrangement. Do not claim that all Inception services are ZDR or that a direct API is authorized by the OpenRouter listing. [Inception privacy policy](https://www.inceptionlabs.ai/docs/privacy-policy).

Upstage's effective July 1, 2026 terms, Article 22, allow storage necessary for service provision/operation and prohibit service-improvement/training use absent separate consent, with an exception for qualifying free services. Third-party services have their own policies. They do not establish that every Solar route has zero retention. [Effective Upstage terms](https://www.upstage.ai/terms-of-service/update-july-01-2026).

The main Upstage terms page is already displaying a version effective September 21, 2026, with a previous-version link covering July 1–September 20. The January page found in search is superseded. This pass uses the effective July version, and requires a terms recheck when the future version takes effect. [Upstage version index](https://www.upstage.ai/terms-of-service).

## Decision interface

Proposed, awaiting owner choice: authorize only the named Mercury and Solar ZDR endpoints through OpenRouter, with explicit endpoint restrictions, `zdr: true`, `data_collection: "deny"`, no route expansion on retry/fallback, and gateway content-logging/product-use opt-ins disabled. Accept OpenRouter's documented categorization and policy-declaration boundary only if the owner selects it. Unknown, conflicting or changed endpoint evidence must stop real-source dispatch pending resolution; research does not supply acceptance of unknown retention.

Before live evaluation, privately verify effective account settings/guardrails, source-use grant and source revisions, endpoint-policy evidence, current prices and conservative spend reservations. Capture requested restrictions separately from observed upstream route/binding. Missing or unapproved observed route must prevent acceptance and further retries; post-response checks cannot undo disclosure. No real-source canary is a substitute for authorization. Preserve USD 100 campaign/USD 2 Debrief operation cumulative allowances, Mercury/Solar separation, and isolated data/output roots.

This research does not verify enforcement, any provider's internal storage/deletion, the account's negotiated agreement, historical route compliance, geographic residency, or a complete subprocessor inventory. Those are not silently converted to ZDR guarantees. The owner may accept the documented boundary or require provider-specific assurance first.

## Owner-selected model extension — 2026-09-10

This extension supersedes the earlier proposed Mercury/Solar endpoint set as product configuration. The owner selected three models and explicitly rejected hardcoded product model restrictions. Evaluation role/frozen gate selection remains a separate pending clarification.

Public endpoint API and ZDR-list GETs returned:

| Selected model | Endpoint observations | Privacy implication |
| --- | --- | --- |
| nex-agi/nex-n2.5-mini:free | nex-agi/bf16; not in ZDR list; advertised input/output price zero | No current ZDR-listed route observed. |
| deepseek/deepseek-v4.1-flash | deepseek not ZDR-listed; io-net/fp8, novita/fp8, deepinfra/fp8, fireworks ZDR-listed | Model identity does not establish which provider gets the source. Io Net had status -5; listing alone does not prove availability. |
| nvidia/nemotron-3.5-lightning | deepinfra/bf16 and coreweave/bf16 ZDR-listed | NVIDIA in the model name does not mean NVIDIA serves the request. |

Sources: [Nex endpoints](https://openrouter.ai/api/v1/models/nex-agi/nex-n2.5-mini:free/endpoints), [DeepSeek endpoints](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints), [Nemotron endpoints](https://openrouter.ai/api/v1/models/nvidia/nemotron-3.5-lightning/endpoints), [ZDR list](https://openrouter.ai/api/v1/endpoints/zdr). These were public metadata calls without credentials or source text, not inference. Pricing is a discovery observation, not a lasting spend estimate.

OpenRouter's provider table labels Nex AGI no-training with 30-day retention. Its linked provider policy returned only a JavaScript application shell to this research tool. The exact provider-specific qualifications and scope therefore remain unverified; a gateway label is not a substitute for an inspected agreement. [Provider table](https://openrouter.ai/providers), [linked Nex policy](https://api.nex-agi.cn/privacy-policy).

DeepInfra's inference documentation states memory-only inputs and no retained outputs/no training for these non-Google/non-Anthropic models, but reserves limited request logging for debugging/security; bulk inference is a distinct retention case. Its general page does not independently prove narrower OpenRouter endpoint terms. [DeepInfra data privacy](https://docs.deepinfra.com/account/data-privacy).

Novita's terms section 10.2 describes default no-training and ZDR with legal, service and technical-support exceptions, plus automated safety screening. This is a qualified policy, not an unconditional promise of no retention. [Novita terms](https://novita.ai/legal/terms-of-service). Other listed endpoints were discovered, not individually cleared by this limited pass; no automatic approval of all current or future hosts follows.

The factual extension is complete with the stated limitations. The pending owner decision is whether to use ZDR-listed routes for the two models and keep Nex synthetic-only, or explicitly accept Nex's stated 30-day retention and remaining uncertainty for real sources. No request was sent to any inference endpoint. Configuration must express the selected models, endpoint policy and exceptions as data, never a source-code model allowlist. Freeze actual campaign choices for comparability and require renewed route evidence when they change.

## Settled owner authorization

The [source/retention resolution](https://github.com/nicolas-found42/chief-of-staff-demo/issues/341#issuecomment-5623607764) supersedes this artifact's earlier pending decision interfaces. The owner allowed all three after disclosure, including Nex's stated 30-day retention and remaining provider-policy uncertainty. ZDR is not claimed for Nex. The three models are development test selections; users choose product provider/model themselves. This decision does not verify endpoint enforcement or actual provider storage behavior.
