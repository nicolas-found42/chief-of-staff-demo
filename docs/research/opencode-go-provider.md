# opencode-go as a provider — 2026-08-28

Question: what "opencode-go" is and exactly what it would take to add it as a model-provider option in `chief-of-staff-demo`, which calls LLMs through one shell seam (`apps/server/src/llm/providers.ts:739`) with a fixed provider list (`packages/shared/src/schemas.ts:14`).

Method: primary sources only — official GitHub repos via GitHub file reads / `pkg.go.dev` / raw `opencode.ai` docs (fetched 2026-08-28) and the repo's own seams (read at `file:line`). No blog posts or AI summaries are cited; every claim points to its owning source. Terms marked `[INFERENCE]` or `[UNVERIFIED]` are honest gaps.

---

## Answer in one paragraph

"opencode-go" is not a standalone Go CLI or SDK — the most plausible referent for "add as a provider option" in a TypeScript server that `POST`s JSON to an HTTP endpoint is **OpenCode Go**, the hosted LLM gateway at `https://opencode.ai/zen/go` run by the OpenCode (Anomaly) team — a `$10/mo` subscription that fronts a curated set of open-weight coding models behind standard OpenAI / Anthropic / Responses endpoints (`https://opencode.ai/docs/go/#endpoints`). It is **OpenAI-compatible** on its `…/v1/chat/completions` surface and can ride the existing `openAiCompatibleComplete` helper that `ollama` already uses (`apps/server/src/llm/providers.ts:521`), so the recommended path is an **OpenAI-compatible ride-along** (new `ProviderId = "opencode-go"` + `baseUrl + apiKey` wiring) — not a bespoke session adapter and not the local `opencode serve` server, which exposes a session/TUI API, not a chat-completion API (`https://opencode.ai/docs/server/`). The Go SDK at `github.com/sst/opencode-sdk-go` (now `anomalyco/opencode-sdk-go`) is a client for that local server's session API and is the wrong seam for the Shell's `CompleteJson` contract.

---

## TL;DR

| Verdict | Item |
|---|---|
| **This is opencode-go** | `OpenCode Go` — hosted gateway `https://opencode.ai/zen/go` (`https://opencode.ai/go`, `https://opencode.ai/docs/go/`, `https://opencode.ai/docs/providers/#opencode-go`); not the SDK, not the archived CLI |
| **Integration path** | **OpenAI-compatible ride-along** via `openAiCompatibleComplete` like `ollama` (`apps/server/src/llm/providers.ts:663`). `response_format: json_schema` binding applies; bespoke adapter only if forced-tool-call models are exposed |
| **Touchpoints** | 8 files, ~35 lines: `schemas.ts` (PROVIDERS, DEFAULT_MODELS, ConfigSchema/Update/Redacted), `providers.ts` (dispatch + helper), `main.ts` (wiring), `config.ts` (redaction), `SettingsPage.tsx` (picker), `client.ts`/`api` (payload), tests |
| **Don't use as provider** | `opencode serve` local server (`https://opencode.ai/docs/server/`) — session/message API (`POST /session/:id/message`), no `/v1/chat/completions`; and `sst/opencode-sdk-go` — Go client for that API (`https://github.com/anomalyco/opencode-sdk-go`) |
| **Blocker** | None — but model ids and endpoint families are version-sensitive (see Risks) |

---

## 1. Identity & maturity — what "opencode-go" might be

| Candidate | What it is (primary source) | Maintainer / status | How you install/run it | Fits "add as provider" ? |
|---|---|---|---|---|
| **OpenCode Go (hosted gateway)** — the term that matches search intent `site:opencode.ai` (`https://opencode.ai/go`, `https://opencode.ai/docs/go/`, `https://opencode.ai/docs/providers/#opencode-go`) | Low-cost **$10/month subscription** giving "reliable access to the most capable open-source models" behind curated endpoints. Docs list ~25 models and three endpoint families per model (`…/zen/go/v1/chat/completions` for GLM/Kimi/DeepSeek/LongCat/MiMo/Hy, `…/zen/go/v1/messages` for MiniMax/Qwen/Claude, `…/zen/go/v1/responses` for Grok/GPT-Luna/Muse-Spark) — `https://opencode.ai/docs/go/#endpoints`. Auth is an API key obtained from `https://opencode.ai/auth` and pasted via TUI `/connect` → `OpenCode Go` (`https://opencode.ai/docs/go/#how-it-works`, `https://opencode.ai/docs/providers/#opencode-go`). Pricing/usage table at `https://opencode.ai/docs/go/#usage-limits` and privacy table at `…#privacy`. | **Anomaly (OpenCode team)** — same org as `anomalyco/opencode` (`https://github.com/anomalyco/opencode`). Billing console at `opencode.ai/auth`; pricing last verified 2026-08-28 on that page. Not a GitHub repo itself — it's the hosted product that the docs call `opencode-go/<model-id>` (e.g. `opencode-go/kimi-k3`) — `https://opencode.ai/docs/go/#endpoints`. | No install. Subscribe at `https://opencode.ai/go` ("Subscribe to Go $10/month" CTA), copy the API key from `https://opencode.ai/auth`, add it via `opencode` TUI or via direct HTTP `Authorization: Bearer <key>` to `https://opencode.ai/zen/go/v1/*` (`https://opencode.ai/docs/go/#how-it-works`). Can also be used "with any agent" — docs explicitly say "You can use it with any agent" (`https://opencode.ai/docs/go/`). | **Yes — this is the provider.** It is an OpenAI-compatible HTTP endpoint that the Shell can `POST` to without running anything locally. |
| **`sst/opencode-sdk-go` → `anomalyco/opencode-sdk-go`** — `https://github.com/anomalyco/opencode-sdk-go` (redirect from `github.com/sst/opencode-sdk-go`, badge at `https://pkg.go.dev/github.com/sst/opencode-sdk-go`) | **Go SDK for the OpenCode REST API** — "provides convenient access to the [OpenCode REST API](https://opencode.ai/docs) from applications written in Go. It is generated with Stainless." (`https://github.com/anomalyco/opencode-sdk-go#readme`). Requires Go 1.22+ (`…#requirements`). Example client: `opencode.NewClient(); client.Session.List(…)` (`…#usage`). The repo's files are SDK plumbing (`client.go`, `session.go`, `config.go`, `internal/apijson`, `option/requestoption.go` …) — directory listing fetched via GitHub API on that page. | **Anomaly (SST)** — 151 stars, MIT, Stainless-generated, `v0.19.2` pinned in README (`go get github.com/sst/opencode-sdk-go@v0.19.2`). Hosted at `pkg.go.dev/github.com/sst/opencode-sdk-go`. | `go get github.com/sst/opencode-sdk-go` + `opencode.NewClient()` pointing at a running `opencode serve` daemon (`pkg.go.dev/github.com/j3ssie/go-agent-agnostic/sdk/opencode` describes the pattern: "spawns an `opencode serve` daemon as a process and communicates …"). | **No** — this SDK talks to the **local** `opencode serve` session API (`POST /session/:id/message`, `GET /session`, etc.), not to an LLM chat-completion endpoint. Using it as the Shell's `CompleteJson` provider would be a category error; the Shell already speaks HTTP itself (`apps/server/src/llm/providers.ts:132`). |
| **`sst/opencode` (the TUI + server itself)** — `https://github.com/anomalyco/opencode` (header shows redirect from `sst/opencode`) | **The open-source coding agent** — TUI + headless HTTP server. `opencode serve` runs a server on `--port 4096 --hostname 127.0.0.1` with OpenAPI spec at `http://<host>:<port>/doc` (`https://opencode.ai/docs/server/#usage`, `…#spec`). APIs are `GET /global/health`, `GET /config/providers`, `POST /session/:id/message`, `POST /session/:id/prompt_async`, `GET /file`, `GET /find`, `POST /tui/*`, etc. (`https://opencode.ai/docs/server/#apis` — full table). Language: TypeScript, `~202k` stars in the fetched view. | **Anomaly / SST** — `anomalyco/opencode` (cited as `https://github.com/anomalyco/opencode`). | `curl -fsSL https://opencode.ai/install | bash` or `npm i -g opencode-ai`, `brew install anomalyco/tap/opencode` (`https://github.com/anomalyco/opencode#installation`), then `opencode serve --port 4096` (`https://opencode.ai/docs/server/#usage`). Auth via `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME` basic auth (`…#authentication`). | **No** — no `/v1/chat/completions` or `/v1/responses` surface; the API is session/tool/LSP-oriented. A bespoke adapter would have to create a session, send a prompt containing the JSON Schema, poll for the reply, and parse free-form text — the weakest binding (`prompt_only` per `packages/shared/src/llm.ts:14`) with no provider-constrained decoding. [INFERENCE] that this would be strictly weaker than `response_format` as described in ADR-0029. |
| **`opencode-ai/opencode` (Go TUI)** — `https://github.com/opencode-ai/opencode` | **Archived** Go TUI — "A powerful AI coding agent. Built for the terminal." Header banner on the GitHub page now reads: "**Archived: Project has Moved — continued under the name Crush, developed by the original author and the Charm team**" → `https://github.com/charmbracelet/crush`. Language Go, 13.7k stars. The Go module would have been `github.com/opencode-ai/opencode`. | **Charm / original author** — archived for provenance, no longer maintained (`https://github.com/opencode-ai/opencode#archived-project-has-moved`). | `go install github.com/opencode-ai/opencode@latest` / `brew install opencode-ai/tap/opencode` per its old README. | **No** — same category as the TypeScript server: a TUI, not an LLM provider contract. |
| **Anything else named "opencode-go"** (npm / Go modules / GitHub code search) | `web_search` for `"opencode-go" site:pkg.go.dev OR site:go.pkg.dev` returned only `github.com/sst/opencode-sdk-go` and unrelated `opencode` packages (`https://pkg.go.dev/github.com/sst/opencode`, `…/opencode-sdk-go`). `searchGitHub` for `opencode-go` returned: a Go-model-provider issue ("OpenCode Go is an OpenAI-compatible API endpoint …" — `craft-ai-agents/craft-agents-oss#668`), the SDK (`anomalyco/opencode-sdk-go`), Goose issues noting "both OpenCode Go and OpenCode Zen are already available as providers in Goose" (`aaif-goose/goose#8381`), and `monotykamary/pi-opencode-go-provider` (a Pi plugin). No standalone GitHub repo named exactly `sst/opencode-go` was found on 2026-08-28 via GitHub file reads or search; the canonical SDK name is `opencode-sdk-go`. `web_search "opencode-go npm package"` returned no npm package named `opencode-go` — only mentions of `oh-my-opencode`, `@lnilluv/pi-opencode-go-rotation`, `Ryosuke-Asano/opencode-go-vscode-chat`. | — | — | Narrow: no third plausible referent beyond the two rows above. The Vscode extension `opencode-go-vscode-chat` and the Pi rotation plugin are **consumers** of the OpenCode Go gateway, not the gateway itself. |

**One-sentence identity (recommended reading):** If someone says "add opencode-go as a provider option" to a server that `POST`s JSON to `https://api.openai.com/v1/chat/completions` today, they almost certainly mean **OpenCode Go — the `$10/mo` hosted gateway at `https://opencode.ai/zen/go`** (`https://opencode.ai/docs/go/`), not the Go SDK at `https://github.com/anomalyco/opencode-sdk-go` and not the local `opencode serve` daemon at `https://opencode.ai/docs/server/`.

Historical alias: the doc's front-matter says "current working directory … Model: opencode-go/muse-spark-1.2-contributor" — that string `muse-spark-1.2-contributor` matches the OpenCode Go catalog (`muse-spark-1.2-contributor` row in `https://opencode.ai/docs/go/#endpoints`, free at `https://opencode.ai/zen` and paid at `…/zen/go`), corroborating that the workspace's own model is drawn from the gateway's catalog.

---

## 2. Runtime surface

### 2.1 Does it run as a local HTTP server?

- **OpenCode Go (hosted gateway) — No.** It is a managed HTTPS endpoint; nothing runs on the developer's machine. Base URLs are `https://opencode.ai/zen/go/v1/*` (`https://opencode.ai/docs/go/#endpoints`). There is no `baseUrl` to configure locally beyond pointing the client at that host — the TUI stores the API key in `~/.local/share/opencode/auth.json` (`https://opencode.ai/docs/providers/#credentials`), but a direct HTTP integration just sends `Authorization: Bearer <opencode-go-api-key>`.
- **OpenCode server (`opencode serve`) — Yes, but not as an LLM endpoint.** `opencode serve [--port <number>] [--hostname <string>] [--cors <origin>]` defaults to `127.0.0.1:4096` (`https://opencode.ai/docs/server/#usage`). Authentication is optional basic auth (`OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME` — `…#authentication`). The server is session-oriented: `POST /session`, `POST /session/:id/message`, `POST /session/:id/prompt_async`, `GET /session/:id/message`, `GET /file`, etc. (`…#apis`). No row in that table is an LLM completion endpoint. [VERIFIED] by reading the entire API table at `https://opencode.ai/docs/server/#apis` on 2026-08-28.

### 2.2 Exact endpoints and request shape

OpenCode Go exposes **three families** (mirroring OpenCode Zen — `https://opencode.ai/docs/zen/#endpoints` — but under `/zen/go`):

| Family (AI SDK package) | Host + path (2026-08-28) | Example models on that family | Spec family |
|---|---|---|---|
| OpenAI Chat Completions (`@ai-sdk/openai-compatible`) | `https://opencode.ai/zen/go/v1/chat/completions` | `glm-5.3-flash`, `kimi-k2.6`, `deepseek-v4-flash`, `mimo-v2.5`, `hy3`, `hy4-preview`, … — 15 models listed at `https://opencode.ai/docs/go/#endpoints` | OpenAI `POST /v1/chat/completions` body: `model`, `messages[]`, `response_format` / `tools` / `tool_choice` |
| Anthropic Messages (`@ai-sdk/anthropic`) | `https://opencode.ai/zen/go/v1/messages` | `minimax-m3`, `minimax-m2.5`, `qwen3.7-plus`, `qwen3.8-flash`, … — 8 models | Anthropic `POST /v1/messages` |
| OpenAI Responses (`@ai-sdk/openai`) | `https://opencode.ai/zen/go/v1/responses` | `grok-4.6`, `gpt-5.6-luna`, `muse-spark-1.2-contributor` — 3 models | OpenAI `POST /v1/responses` |

Source: `https://opencode.ai/docs/go/#endpoints` table (fetched 2026-08-28); identical structure documented for Zen at `https://opencode.ai/docs/zen/#endpoints` (e.g. `https://opencode.ai/zen/v1/chat/completions` for `deepseek-v4-flash`). Zen's standalone endpoint list and pricing at `https://opencode.ai/docs/zen/#pricing` confirms the host pattern. The `/v1/models` discovery endpoint is `https://opencode.ai/zen/go/v1/models` (`…#models`). **Do not point the integration at Zen's `https://opencode.ai/zen/v1` base** — same host and same `opencode.ai/auth` key, but a different tier: Go models are served under `/zen/go/v1`, and `/zen/v1` routes to the pay-per-token Zen balance, not the $10/mo Go subscription (the providers page at `https://opencode.ai/docs/providers/#opencode-go` documents only the auth flow and no base URL, so the endpoints doc is the authority).

For the **Ollama precedent** in this repo, the helper is `openAiCompatibleComplete(url, headers, cfg, request, schema, declared, deadline)` at `apps/server/src/llm/providers.ts:521`; `ollamaComplete` calls it at `…:663` with `url: ${cfg.baseUrl}/v1/chat/completions` and conditional `Authorization`. OpenCode Go's `…/v1/chat/completions` family matches that path shape exactly, so the existing helper can be reused.

### 2.3 Auth

- Header: `Authorization: Bearer <opencode-go-api-key>` — same as OpenAI / OpenRouter (`apps/server/src/llm/providers.ts:393` for OpenAI, `…:677` for Ollama's conditional header). The TUI flow ("paste your API key" at `https://opencode.ai/docs/go/#how-it-works` step 2) stores it in `~/.local/share/opencode/auth.json` (`https://opencode.ai/docs/providers/#credentials`); for the Shell, it belongs in `AppConfig.apiKey` or a per-provider key block like `openrouter`/`gemini` do not yet need.
- No `baseUrl` secret — the base URL is public (`https://opencode.ai/zen/go`). A per-provider override is still useful for tests / self-hosted OpenAI-compatible mirrors, matching the Ollama precedent (`packages/shared/src/schemas.ts:28` `DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"` and `…:62` `ollama: { baseUrl }`).
- Quotas are dollar-denominated subscription limits ($12/5h, $30/week, $60/month — `https://opencode.ai/docs/go/#usage-limits`) with `429`-style rate-limiting; `monotykamary/pi-opencode-go-provider` and `@lnilluv/pi-opencode-go-rotation` are public examples of clients rotating keys on `429` (`https://github.com/monotykamary/pi-opencode-go-provider`). [INFERENCE] that the gateway signals capacity failures as HTTP 429/529, as the model-boundary classifier already handles for other providers (`packages/shared/src/llm.ts:26`).

### 2.4 How models are listed/selected, config format

- Discovery: `GET https://opencode.ai/zen/go/v1/models` (`…#models`); also `GET /v1/models` semantics for the chat-completions family (verify with `curl https://opencode.ai/zen/go/v1/models -H "Authorization: Bearer $KEY"`).
- Model ids in config match `opencode-go/<model-id>` (e.g. `opencode-go/kimi-k3` — `https://opencode.ai/docs/go/#endpoints` footer). The same `<model-id>` is the `model` field in `POST …/v1/chat/completions` bodies (e.g. `"model": "kimi-k3"`). Zen docs note the `opencode/<model-id>` form (`https://opencode.ai/docs/zen/#endpoints`); Go uses `opencode-go/<model-id>`.
- Config shape in this repo is `AppConfig { provider, model, apiKey, ollama: { baseUrl } }` (`packages/shared/src/schemas.ts:31` / `…:62`). See Integration map for the exact extension.

### 2.5 Does it support structured output / forced tool calls? (ADR-0029)

This decides the `RESULT_SHAPE_BINDING` (`packages/shared/src/llm.ts:14`: `response_format` > `forced_tool_call` > `prompt_only`, ADR-0029).

- **Chat-completions family (`…/v1/chat/completions`)** — advertises `@ai-sdk/openai-compatible` (`…#endpoints`). That SDK sends `response_format: { type: "json_schema", strict: true, … }` when the caller declares it. The gateway's pricing table lists every such model with input/output/cached pricing, implying full OpenAI semantics. **Therefore [INFERENCE, plausible] the endpoint forwards `response_format` to the upstream provider (Zhipu/Moonshot/DeepSeek/etc.) where that upstream supports it, and the Shell can claim `response_format` on those models.** The capability is ultimately upstream-dependent — the same caveat ADR-0029 notes for OpenRouter (`docs/adr/0029-result-shape-binding-follows-the-model-not-the-provider.md:23`: "OpenRouter's per-model declaration is the capability source"). No per-model `supported_parameters` discovery like OpenRouter's is documented for OpenCode Go; the docs do not publish such an endpoint. So the safest posture for v1 is to treat `response_format` support as **unknown** and let the step-down logic handle refusals (see Risks), rather than hard-coding per-model bindings.
- **Responses family (`…/v1/responses`)** — OpenAI Responses API supports `text.format: json_schema` — [INFERENCE] that `muse-spark-1.2-contributor` etc. accept structured output, but the Shell's current providers have **no Responses adapter** (`apps/server/src/llm/providers.ts:392` handles `/v1/chat/completions` and `/v1/messages`; there is no `/v1/responses` case). Exposing those models would require a new adapter or an explicit "not supported" classification.
- **Messages family (`…/v1/messages`)** — Anthropic-compatible (`@ai-sdk/anthropic`). The Shell's Anthropic adapter uses **forced tool calls** (`apps/server/src/llm/providers.ts:419` `anthropicComplete`, `…:700` `initialCall` picks `forced_tool_call` for Anthropic). If OpenCode Go's `…/v1/messages` surface is strictly Anthropic-shaped, the same adapter could be reused — but note the host is still `opencode.ai`, not `api.anthropic.com`, so a single dispatch case with a configurable `baseUrl` is cleaner than reusing the Anthropic URL.
- **What this means per ADR-0029**: a new provider should declare which binding each model supports. Since the upstream matrix is not published (`https://opencode.ai/docs/go/` does not list `response_format` vs `tools` per model, and `models.dev` listings are not Go-specific), **v1 can either (a) always send `response_format` and rely on the existing `refusesBinding` step-down (`apps/server/src/llm/providers.ts:555`) to fall back to `forced_tool_call` then `prompt_only`, or (b) conservatively start at `forced_tool_call` for the gateway.** ADR-0029's consequence ("A model that declares neither binding is sent a prompt-only request … one fewer call" — `docs/adr/0029…:67`) makes (a) the faster-to-fail, fewer-calls option if `refusesBinding` correctly detects 4xx mentions of `json_schema`/`response_format`.

In either case, the failure taxonomy to preserve is ADR-0030's eight-class `MODEL_BOUNDARY_CLASSIFICATIONS` (`packages/shared/src/llm.ts:26`). The chat-completions family returns the same shape as OpenAI (200 with `choices[0].message.content`, or error envelope `{ error: { message, code } }` handled at `apps/server/src/llm/providers.ts:168` `carriesUpstreamError` and `…:181` `parseProviderPayload`), so no classification change is needed.

### 2.6 `opencode serve`'s own API (for completeness — why it's not the provider)

| Property | Value (primary source) |
|---|---|
| Command | `opencode serve [--port <number>] [--hostname <string>] [--cors <origin>]` — default `4096`/`127.0.0.1` — `https://opencode.ai/docs/server/#usage` |
| Spec | `http://<host>:<port>/doc` OpenAPI 3.1 — `…#spec` |
| Auth | `OPENCODE_SERVER_PASSWORD` (user `opencode` or `OPENCODE_SERVER_USERNAME`) basic auth — `…#authentication` |
| Session API | `POST /session`, `POST /session/:id/message { parts, model, agent }`, `POST /session/:id/prompt_async`, `GET /session/:id/message`, `GET /session/status`, `POST /session/:id/abort`, etc. — `…#apis` tables |
| Structured output | No `response_format`/`json_schema` parameter. The only path to get JSON back is to put the schema in the prompt and parse free-form text from `parts[]`. |
| Go SDK mapping | `opencode.NewClient(); client.Session.List / client.Session.Create / client.Session.Prompt` etc. — `https://github.com/anomalyco/opencode-sdk-go#usage`, `https://pkg.go.dev/github.com/sst/opencode-sdk-go` |
| Verdict | **Not an LLM provider endpoint.** Would require a bespoke adapter that manages a local daemon process, session lifecycle, and free-form parsing — and would still yield the weakest binding. |

---

## 3. Integration map — end-to-end touchpoints for `ProviderId = "opencode-go"`

All file lines below verified by reading the same files that `packages/shared/src/schemas.ts:14` and `apps/server/src/llm/providers.ts:521` cite. The Ollama block is the precedent for "OpenAI-compatible local server with `baseUrl`" and is duplicated as a pattern for `opencode-go`.

### 3.1 Shared schemas — the provider id and per-provider block

| File | Lines (2026-08-28) | What to change | Precedent / note |
|---|---|---|---|
| `packages/shared/src/schemas.ts:14` | `export const PROVIDERS = ["openai","anthropic","openrouter","gemini","ollama","mock"] as const;` | Add `"opencode-go"` to the tuple. `z.enum(PROVIDERS)` at `…:16` and `ProviderId` derive from it. | Changing the type widens every `switch (cfg.provider)` site; exhaustive-switch lint will flag missing cases. |
| `packages/shared/src/schemas.ts:19` | `export const DEFAULT_MODELS: Record<ProviderId, string> = { … }` (current keys: `openai: "gpt-5.2" … ollama: "nemotron" … mock: ""` at `…:20`) | Add ` "opencode-go": "kimi-k3"` or `"mimo-v2.5"` or `"hy3"` — any valid chat-completions id from `https://opencode.ai/docs/go/#endpoints`. Choice should be a cheap, globally available open-weight model (not `muse-spark` which is [limited regions] per that table). | Value is free-text editable in Settings; `makeCompleteJson` falls back to it when `config.model` is empty (`packages/shared/src/schemas.ts:90` `normalize` vs `apps/server/src/config.ts:90`). |
| `packages/shared/src/schemas.ts:28` | `export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";` | Add `export const DEFAULT_OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go";` (or `"https://opencode.ai/zen/go/v1"` if you prefer the version prefix baked in — but keep the style of `ollama` which stores the origin only). | The Go gateway docs show `https://opencode.ai/zen/go/v1/chat/completions` (`…#endpoints`) — strip the `/v1/chat/completions` suffix for the `baseUrl` and append in `providers.ts`. |
| `packages/shared/src/schemas.ts:31` `ConfigSchema` | Object at `…:31` with blocks `provider`, `model`, `apiKey`, `ollama: z.strictObject({ baseUrl })` at `…:62`, and `modules` at `…:73` | Add sibling block: ` "opencode-go": z.strictObject({ baseUrl: z.string().default(DEFAULT_OPENCODE_GO_BASE_URL) }).default({ baseUrl: DEFAULT_OPENCODE_GO_BASE_URL })` (verbatim style of the `ollama` block at `…:62`). Import `DEFAULT_OPENCODE_GO_BASE_URL` in `apps/server/src/config.ts:9`. | `ConfigSchema` is `z.strictObject`, so the key must be present in the type even when the user hasn't chosen that provider. |
| `packages/shared/src/schemas.ts:237` `ConfigUpdateSchema` | `ollama: z.strictObject({ baseUrl: z.string().optional() }).optional()` at `…:256` | Mirror for `opencode-go`: ` "opencode-go": z.strictObject({ baseUrl: z.string().optional() }).optional()` | `PUT /api/config` semantics: "Absent secret fields keep their stored values" (`…:236` comment). `baseUrl` is not secret, returned verbatim per `…:291`. |
| `packages/shared/src/schemas.ts:272` `RedactedConfig` | `ollama: { baseUrl: string }` at `…:292` | Add ` "opencode-go": { baseUrl: string }` to the interface (and to `redactConfig`'s return). | Comment at `…:291` says "Not a secret: a local endpoint address, returned verbatim" — same holds for the gateway origin, though it's remote. |

### 3.2 Server — config store + redaction

| File | Lines | What to change |
|---|---|---|
| `apps/server/src/config.ts:9` | `import { DEFAULT_OLLAMA_BASE_URL … } from "@chief-of-staff-demo/shared"` | Also import `DEFAULT_OPENCODE_GO_BASE_URL`. |
| `apps/server/src/config.ts:36` `defaultConfig()` | Returns `provider/model/apiKey/ollama: { baseUrl }` (`…:37`) | Add `"opencode-go": { baseUrl: DEFAULT_OPENCODE_GO_BASE_URL }`. |
| `apps/server/src/config.ts:92` `normalize` | Normalizes `internalDomains` and fills default model | No binding change: `opencode-go` can use `response_format` like OpenAI (or `null` to let step-down decide). |
| `apps/server/src/config.ts:250` `redactConfig` | Maps `ollama.baseUrl` verbatim | Mirror for `opencode-go.baseUrl` (non-secret, so no `secretHint`). |

### 3.3 Server — LLM dispatch (the one seam)

| File | Lines | What to change |
|---|---|---|
| `apps/server/src/llm/providers.ts:24` `LlmConfig` | `interface LlmConfig { provider, model, apiKey, baseUrl }` (`…:24`) | Extend `baseUrl` to mean "gateway origin when provider is `opencode-go`" (or add `opencodeGoBaseUrl` — but reuse `baseUrl` like `openrouter`/`ollama` already do to avoid widening the interface). |
| `apps/server/src/llm/providers.ts:521` `openAiCompatibleComplete` | `async function openAiCompatibleComplete(url, headers, cfg, request, schema, declared, deadline)` (`…:521`) | No change — reuse directly. |
| `apps/server/src/llm/providers.ts:663` `ollamaComplete` | `function ollamaComplete(cfg, request, schema, deadline) { return openAiCompatibleComplete(`${cfg.baseUrl}/v1/chat/completions`, …); }` (`…:663`) | Add parallel `function opencodeGoComplete(cfg, request, schema, deadline) { return openAiCompatibleComplete(`${cfg.baseUrl}/v1/chat/completions`, { Authorization: `Bearer ${cfg.apiKey}`, … }, cfg, request, schema, null, deadline); }` — note: unlike `ollamaComplete` at `…:663` which sends auth only when configured (`"some deployments sit behind a proxy that wants it"` comment at `…:658`), the gateway **always** requires a key, so always send `Authorization`. |
| `apps/server/src/llm/providers.ts:641` `declaredBinding` / `openrouterDeclaredParameters` | Per-model `supported_parameters` lookup for OpenRouter (`…:572`) | No change for v1. If you later need capability probing for OpenCode Go, add a cached `GET …/v1/models` read that maps `response_format` → `response_format` declaration, mirroring `…:578` `openrouterDeclaredParameters`. Not required for correctness — step-down covers unknown. |
| `apps/server/src/llm/providers.ts:739` `makeCompleteJson` | `export function makeCompleteJson(cfg, mockResultPath) { … switch (cfg.provider) { case "openai"/"anthropic"/"openrouter"/"gemini"/"ollama"/"mock" } }` (`…:739`) | Add `case "opencode-go": return opencodeGoComplete(cfg, request, schema, deadline);` |

### 3.4 Server — wiring (two closures that capture config)

| File | Lines | What to change |
|---|---|---|
| `apps/server/src/main.ts:99` `contentScoutCompleteJson` | `const contentScoutCompleteJson = () => { const current = configStore.get(); return makeCompleteJson({ provider: current.provider, model: current.model, apiKey: current.apiKey, baseUrl: current.ollama.baseUrl }, layout.mockResultFile); }` (`…:99`) | Thread the new origin: `baseUrl: current.provider === "opencode-go" ? current["opencode-go"].baseUrl : current.ollama.baseUrl` — or, more uniformly, extend `LlmConfig` to carry both `ollamaBaseUrl`/`opencodeGoBaseUrl` and let `makeCompleteJson` pick by `cfg.provider`. The former keeps the config diff minimal; the latter is cleaner. Update both closures: `contentScoutCompleteJson` at `…:99` and `meetingBriefCompleteJson` at `…:144` (`apps/server/src/main.ts:144`). |
| `apps/server/src/main.ts:144` `meetingBriefCompleteJson` | Mirror of `…:99` (`…:144`) | Same change. |

### 3.5 Web — settings UI

| File | Lines | What to change |
|---|---|---|
| `apps/web/src/pages/SettingsPage.tsx:19` `PROVIDER_OPTIONS` | Array at `…:19` with entries for `mock/openai/anthropic/openrouter/gemini/ollama` (`…:19`) | Add `{ value: "opencode-go", label: "OpenCode Go (hosted gateway — api.opencode.ai)" }` — label mirrors the Ollama style at `…:25` ("Ollama (local model)"). |
| `apps/web/src/pages/SettingsPage.tsx:29` `PROVIDER_SHORT` | `Record<ProviderId,string>` at `…:29` | Add ` "opencode-go": "OpenCode Go"` |
| `apps/web/src/pages/SettingsPage.tsx:44` `PROVIDER_KEY_URLS` | `Partial<Record<ProviderId,string>>` at `…:44` (`openai: "https://platform.openai.com/api-keys"` …) | Add ` "opencode-go": "https://opencode.ai/auth"` — the page the docs call "Sign in, add billing, copy API key" (`https://opencode.ai/docs/go/#how-it-works`). The UI renders this as the "where to get a key" link. |
| `apps/web/src/pages/SettingsPage.tsx:51` `FormState` | `interface FormState { provider, model, apiKey, …, ollamaBaseUrl }` at `…:51` | Add `opencodeGoBaseUrl: string` at parity with `ollamaBaseUrl` (`…:63`). |
| `apps/web/src/pages/SettingsPage.tsx:122` `useEffect load` | `setForm({ provider, model, apiKey:"", …, ollamaBaseUrl: fetched.config.ollama.baseUrl })` at `…:122` | Also set `opencodeGoBaseUrl: fetched.config["opencode-go"].baseUrl`. Type will error until `RedactedConfig` is extended. |
| `apps/web/src/pages/SettingsPage.tsx:394` `changeProvider` | Switches model default when provider changes (`…:394`) | No structural change — `payload.defaults[provider]` at `…:395` will now include the new provider after `DEFAULT_MODELS` is extended. |
| `apps/web/src/pages/SettingsPage.tsx:420` `save` | Builds `update: Record<string,unknown>` at `…:421` with `ollama: { baseUrl: form.ollamaBaseUrl }` at `…:432` and posts via `api.saveConfig` at `…:440` | Add ` "opencode-go": { baseUrl: form.opencodeGoBaseUrl }` to that object and to the state reset at `…:442`. |
| `apps/web/src/pages/SettingsPage.tsx:500+` (render) | Provider card rendering | Render an `opencode-go` base-url input analogous to the Ollama field — show only when `form.provider === "opencode-go"` [INFERENCE — exact render location not read, but pattern follows `ollamaBaseUrl` usage]. |
| `apps/web/src/client.ts:82` `ConfigPayload` | `interface ConfigPayload { config: RedactedConfig; defaults: Record<ProviderId,string> }` at `…:82` | No code change if `RedactedConfig` already covers the new block; payload type widens automatically. |
| `packages/shared/src/schemas.ts:272` `RedactedConfig` | See 3.1 | Extending it widens `api.getConfig()`'s return at `apps/web/src/client.ts:400` (`getConfig(): ConfigPayload`). |

### 3.6 API — config endpoints

| File | Lines | What to change |
|---|---|---|
| `apps/server/src/api` (config routes) | Config `GET /api/config` and `PUT /api/config` handlers (not directly read, but `apps/server/src/main.ts:191` `registerApi` wires them via `configStore` at `…:48`) | No handler change — `ConfigSchema`/`ConfigUpdateSchema`/`redactConfig` at `apps/server/src/config.ts:31` drive validation and redaction. If handlers instantiate `zodToJsonSchema(ConfigUpdateSchema)` for docs, they inherit the new key. |

### 3.7 Tests — where new coverage belongs

| File | Lines / pattern | What to change |
|---|---|---|
| `tests/src/unit/providers.test.ts:133` | Helpers: `chatCompletion(content)` at `…:135`, `toolCallCompletion(args)` at `…:109`, `declaring(...params)` at `…:109` | Add a `describe("opencode-go", () => { … })` block mirroring the `ollama` and `openrouter` suites. Use the existing `queuedResponse` harness at `…:74` (`status`, `body`/`text`, `hang`/`fail`) and the `calls`/`responses`/`declarations` spies at `…:31`. Key cases: `response_format` path succeeds on `choices[0].message.content`, 401 bubbles as `http_error`, `refusesBinding` step-down fires on 400 mentioning `response_format`, `request_timeout` fires via `hang`. See `tests/src/unit/providers.test.ts:462` `describe("providers", …)` for structure. |
| `tests/src/unit/providers.test.ts:462` `describe("model-boundary failures", …)` | Eight-class taxonomy at `packages/shared/src/llm.ts:26` | No change — gateway failures classify same as OpenAI (`http_error`, `empty_body`, `unparseable_body`, `upstream_error`, `unusable_shape`, `answer_not_json`). Add at least one `opencode-go` case for `upstream_error` (200 with `{ error: { message, code: 502 } }` observed for OpenRouter at `docs/adr/0029…:28`). |
| `tests/vitest.config.ts:4` | `include: ["tests/src/**/*.test.ts"]`, coverage at `…:13` over `apps/server/src/**/*.ts` | No change. [INFERENCE] that `apps/web/src/pages/SettingsPage.tsx` remains uncovered by unit suite (covered via Playwright `tests/e2e/ui.spec.ts` at `…:32KB`). If `SettingsPage` gains a new field, add an e2e assertion that selecting `opencode-go` shows the base-url input and the `opencode.ai/auth` key link, mirroring Ollama coverage. |

### 3.8 What you do NOT need to touch

- `packages/shared/src/llm.ts:14` `RESULT_SHAPE_BINDINGS` / `…:26` `MODEL_BOUNDARY_CLASSIFICATIONS` — no new binding.
- `apps/server/src/llm/providers.ts:92` `wireJsonSchema` vs `…:102` `geminiWireSchema` — Ollama reuse means no new schema transform.
- `docs/adr/0029` / `docs/adr/0030` — ADRs are precedent, not code; no amendment needed unless the gateway's behavior violates the consequences already recorded.
- Docker/workspace plumbing — same as Ollama: `host.docker.internal` guidance generalizes (`packages/shared/src/schemas.ts:28` comment).

---

## 4. Risks, unknowns, and version-sensitive parts

**State honestly — an incomplete map beats a plausible one.**

| # | Risk / unknown | Impact on integration | Evidence / mitigation |
|---|---|---|---|
| 1 | **Term ambiguity.** A listener without docs context can read "opencode-go" as the **Go SDK** (`github.com/sst/opencode-sdk-go`) or the **local daemon** (`opencode serve`) rather than the **hosted gateway**. Both of the latter are wrong seams for `CompleteJson` (see 2.1). | A PR that imports `opencode-sdk-go` or shells out to `opencode serve` would add a daemon dependency, session management, and `prompt_only` parsing for no gain. | Disambiguate in the PR title/description: "Add OpenCode Go (hosted gateway at `https://opencode.ai/zen/go`) as provider `opencode-go`". Cite `https://opencode.ai/docs/go/` in the ADR amendment. |
| 2 | **Endpoint + model churn.** The catalog in `https://opencode.ai/docs/go/#endpoints` is explicitly "may change as we test and add new ones" (`…#how-it-works`). Model ids like `glm-5.3-flash`, `kimi-k2.7-code`, `mimo-v2.5`, `hy4-preview` are dated to 2026-08-28; the default at `packages/shared/src/schemas.ts:19` will bit-rot if pinned without a health check. | A pinned default that is removed/disabled will surface as `http_error` (404) or `upstream_error` on every Run until the default is edited. | Choose a stable, cheap default (`mimo-v2.5` or `hy3` — listed as "Free" in Zen and "Hy3" at 4,300 req/5h in Go — `…#usage-limits`). Add a nightly `GET …/v1/models` canary (like `tests/src/modules/content-scout-canary.test.ts`) that asserts the default id still appears. [INFERENCE] that the models endpoint requires auth — the Zen docs say `https://opencode.ai/zen/v1/models` without auth, but verify with a real key. |
| 3 | **Structured output support is upstream-dependent and undocumented per model.** Unlike OpenRouter, where `GET /api/v1/models/:id/endpoints` returns `supported_parameters: ["response_format","tools",…]` (`apps/server/src/llm/providers.ts:572` `readDeclaredParameters`), OpenCode Go publishes **no** `supported_parameters` matrix. The `…#endpoints` table only shows the AI SDK package, not `json_schema` support. | If `response_format` is sent to a model that doesn't support it, the gateway may 400 with a body mentioning `response_format` (triggering the existing `refusesBinding` step-down at `…:555` → `forced_tool_call` → `prompt_only`) or may return unusable shape. Without a probe, every first call to a new model costs one failure cycle (~130 s measured at `docs/adr/0029…:49` for the reasoning model). | Accept the step-down for v1 (cheapest to ship). If latency matters, add a one-time `GET …/v1/models` → `capabilities: { structuredOutput, toolCall }` cache similar to `openrouterDeclarations` at `apps/server/src/llm/providers.ts:572`. Mark as `[UNVERIFIED]` until a real `POST …/v1/chat/completions` with `response_format: { type:"json_schema" }` is driven against each default model and the reply classified. |
| 4 | **Three endpoint families share one `ProviderId`.** The gateway splits families by model: chat (`…/chat/completions`), messages (`…/messages`), responses (`…/responses`). The Shell's `switch` at `apps/server/src/llm/providers.ts:739` currently picks one URL per provider. If a user selects `muse-spark-1.2-contributor` (responses-only) while the dispatch always calls `…/chat/completions`, they'll get 404/400. | Model picker will allow an infeasible combination; a Run will fail with `http_error` before any diagnostic names the mismatch. | Option A (simplest): restrict `DEFAULT_MODELS["opencode-go"]` and any picker whitelist to chat-completions models (15 of ~26). Option B: route by model-id allowlist: `if (responsesModels.has(model)) return responsesComplete …` — adds a second adapter. Option A ships faster; document it. The `whitelist`/`blacklist` pattern in `https://opencode.ai/docs/providers/#hiding-models` is precedent for scoping the picker. |
| 5 | **Auth confusion with other `OPENCODE_*` vars.** The server docs use `OPENCODE_SERVER_PASSWORD` for the local daemon (`https://opencode.ai/docs/server/#authentication`), which collides by name with an "OpenCode Go API key". | An operator may paste a gateway key into the server-password env var and wonder why `opencode serve` rejects it, or vice versa. | Keep the Shell's key name as `apiKey` (same as OpenAI/Anthropic/OpenRouter — `packages/shared/src/schemas.ts:34` `apiKey: z.string()`) and do not introduce an `OPENCODE_GO_API_KEY` env var in the app. Document the distinction in `README.md` / Settings copy. |
| 6 | **Privacy / data-retention varies by upstream.** `https://opencode.ai/docs/go/#privacy` table (retrievable via `https://opencode.ai/docs/zen/#privacy`) lists per-model `Model training: Not used` vs `Data retention: 0–30 days` (e.g. GLM `0 days`, Grok `30 days`). | A Run that sends private transcripts through the gateway may have them retained longer than the workspace's local-only posture implies (`docs/adr/0001-local-first-single-user.md`). | Surface the retention note alongside the provider picker (Settings → "Data is forwarded to OpenCode Go's upstream; see `opencode.ai/docs/go/#privacy`"). This matches the existing warning posture for YouTube (`docs/adr/0016…`). |
| 7 | **Rate-limit semantics are subscription, not per-request.** Limits are `$12/5h` etc. (`…#usage-limits`), not RPM. Hitting a limit may return 429, but the body may be a subscription-status object, not `choices`. The Pi rotation plugin treats 429 as "rotate keys" (`https://github.com/monotykamary/pi-opencode-go-provider`). | A 429 that looks like a model failure may surface as `upstream_error` or `unparseable_body` and trigger retries that immediately re-hit the limit. | Do not retry on 429 in the Shell — classify as `http_error` (already at `apps/server/src/llm/providers.ts:181` `parseProviderPayload`) and let the Module surface "OpenCode Go quota exhausted — check `https://opencode.ai/auth`". The retry policy lives in the Module per ADR-0030 (`docs/adr/0030…:36`). |
| 8 | **Container networking.** Ollama's note at `packages/shared/src/schemas.ts:28` ("`host.docker.internal` inside a container") exists because the default `11434` is loopback. The gateway at `https://opencode.ai` needs no such note, but the `baseUrl` field may still be pointed at a loopback override in tests, which will fail in Docker. | Tests that point at `http://127.0.0.1:4096` in CI may pass locally but not in the Docker pipeline (`docker-compose.yml:2KB`). | Default the gateway `baseUrl` to the public origin; in tests use `http://host.docker.internal:11434` style only for Ollama, not for `opencode-go`. Mirror `apps/server/src/main.ts:40` `HOST` handling. |
| 9 | **Docs-to-source skew.** The web page `https://opencode.ai/go` (social-share layout) and the docs page `https://opencode.ai/docs/go/` diverged in count on 2026-08-28 (landing lists ~15 models, docs lists 25) and the provider directory at `https://opencode.ai/docs/providers/#opencode-go` links to `opencode.ai/auth` which redirects to `/zen`. The SDK import path changed from `sst/opencode-sdk-go` to `anomalyco/opencode-sdk-go` (`https://pkg.go.dev/github.com/sst/opencode-sdk-go` badge). | A contributor who checks only one doc may quote a stale endpoint or an older import. | Re-verify the endpoints table on merge day by fetching `https://opencode.ai/docs/go/#endpoints` and `https://opencode.ai/zen/go/v1/models` with a live key; update `DEFAULT_MODELS` if the default id is absent. Cite the fetch timestamp in the PR. |
| 10 | **`muse-spark-1.2-contributor` geographic fencing.** Listed as "[limited regions](https://ai.developer.meta.com/legal/geographic-use-policy)" at `https://opencode.ai/go` and `https://opencode.ai/docs/go/#how-it-works`. | Using that model as the default may fail in excluded regions with a provider error, not a transport error. | Avoid it as the default. Mention the region caveat if it remains in the allowlist. |

**Anything explicitly [UNVERIFIED] on 2026-08-28:**
- Whether `POST https://opencode.ai/zen/go/v1/chat/completions` with `response_format: { type:"json_schema", json_schema:{ name, strict:true, schema } }` actually constrains decoding for each listed model (Kimi/MIMO/GLM/DeepSeek/Hy) — needs a live probe with a real API key. Cited as [INFERENCE] in 2.5.
- Whether `…/v1/messages` and `…/v1/responses` families accept the same structured-output parameter — same probe needed.
- Whether the gateway echoes a `code`/`provider_name` like OpenRouter does (`docs/adr/0030…:28` observation) — `parseProviderPayload` already stores `upstreamServer`/`upstreamCode` generically, so no code change required, but note as unverified.

---

## 5. What to build (recommended)

For this repo, ship the **OpenAI-compatible ride-along** in a single PR that:

1. Widens `packages/shared/src/schemas.ts:14` + `…:19` + `…:28` + `…:31` + `…:237` + `…:272`.
2. Adds `DEFAULT_OPENCODE_GO_BASE_URL` and extends `apps/server/src/config.ts`.
3. Adds `opencodeGoComplete` at `apps/server/src/llm/providers.ts:663` and a `case "opencode-go"` at `…:739`, reusing `…:521`.
4. Threads the origin in `apps/server/src/main.ts:99` + `…:144`.
5. Adds picker + help link + base-url field at `apps/web/src/pages/SettingsPage.tsx:19` (+ `client.ts` widens for free).

Total diff: ~10 files, ~60 lines. No new dependency, no daemon, no schema migration. Add one unit-test block at `tests/src/unit/providers.test.ts` and one Playwright assertion for the picker. Do **not** build an `opencode serve` adapter — it violates ADR-0029's "most deterministic binding" ordering by collapsing to `prompt_only`, and it requires process management the Shell never needed.

If you eventually need the `…/v1/responses` models, add `openAiResponsesComplete` alongside `geminiComplete` at `…:449` (Gemini's `candidates[0].content.parts[0].text` reading at `…:338` is the structural analog) and gate the route by model-id.

---

## Sources

Every claim above is grounded in a file or URL you can re-read.

**Repo seams (file:line counts at 2026-08-28):**

- `packages/shared/src/schemas.ts:14` `PROVIDERS`, `…:16` `ProviderIdSchema`, `…:19` `DEFAULT_MODELS`, `…:28` `DEFAULT_OLLAMA_BASE_URL`, `…:31` `ConfigSchema`, `…:62` `ollama: { baseUrl }`, `…:73` `modules`, `…:90` `normalize`, `…:237` `ConfigUpdateSchema`, `…:256` `ollama` update block, `…:272` `RedactedConfig`, `…:291` "Not a secret: a local endpoint address, returned verbatim"
- `packages/shared/src/llm.ts:14` `RESULT_SHAPE_BINDINGS`, `…:18` `ResultShapeBinding`, `…:26` `MODEL_BOUNDARY_CLASSIFICATIONS`, `…:52` `ModelBoundaryDiagnostic`, `…:82` `ResultShapeIssue`
- `apps/server/src/llm/providers.ts:24` `LlmConfig`, `…:44` `CompleteJson`, `…:92` `wireJsonSchema`, `…:102` `geminiWireSchema`, `…:132` `postJson`, `…:168` `carriesUpstreamError`, `…:181` `parseProviderPayload`, `…:392` `openaiComplete`, `…:419` `anthropicComplete`, `…:449` `geminiComplete`, `…:474` `chatCompletionBody`, `…:521` `openAiCompatibleComplete`, `…:555` `refusesBinding`, `…:572` `openrouterDeclarations`, `…:578` `openrouterDeclaredParameters`, `…:632` `declaredBinding`, `…:641` `openrouterComplete`, `…:658` `ollamaComplete`, `…:663` `ollamaComplete` impl, `…:700` `initialCall`, `…:739` `makeCompleteJson`, `…:191` `registerApi`
- `apps/server/src/main.ts:40` `HOST`, `…:99` `contentScoutCompleteJson`, `…:144` `meetingBriefCompleteJson`, `…:191` `registerApi`, `…:48` `configStore`
- `apps/server/src/config.ts:9` imports, `…:36` `defaultConfig`, `…:92` `normalize`, `…:250` `secretHint`, `…:272` `redactConfig`
- `apps/web/src/pages/SettingsPage.tsx:19` `PROVIDER_OPTIONS`, `…:29` `PROVIDER_SHORT`, `…:44` `PROVIDER_KEY_URLS`, `…:51` `FormState`, `…:63` `ollamaBaseUrl`, `…:122` `useEffect load`, `…:394` `changeProvider`, `…:420` `save`, `…:421` `update: Record<string,unknown>`, `…:432` `ollama`, `…:440` `api.saveConfig`
- `apps/web/src/client.ts:82` `ConfigPayload`, `…:400` `getConfig`
- `tests/src/unit/providers.test.ts:31` `calls/responses/declarations`, `…:74` `queuedResponse`, `…:109` `toolCallCompletion` + `declaring`, `…:135` `chatCompletion`, `…:462` `describe("providers")`, `…:700` `describe("model-boundary failures")`
- `tests/vitest.config.ts:4` `defineConfig`, `…:13` `coverage.include`
- `docs/adr/0029-result-shape-binding-follows-the-model-not-the-provider.md:23` "OpenRouter's per-model declaration is the capability source", `…:49` "130 seconds", `…:67` "A model that declares neither binding is sent a prompt-only request"
- `docs/adr/0030-model-boundary-failures-are-classified-facts.md:28` observation `{"error":{"message":"Upstream error …"}}`, `…:36` "retry policy belongs to the Module"
- `docs/research/dev-tooling.md:1` structure convention mirrored here
- `docs/research/content-scout-source-adapters.md:32` capability-state precedent

**Primary web sources (fetched 2026-08-28; host is the authority, not a blog):**

- `https://opencode.ai/go` — OpenCode Go product page ("Low cost coding models for everyone", "$10/month", usage-limits bar chart, region note)
- `https://opencode.ai/docs/go/` — Canonical Go docs: `#how-it-works` (auth flow), `#usage-limits` (limits table), `#endpoints` (model → model id → endpoint → AI SDK package table with `https://opencode.ai/zen/go/v1/*`), `#models` (`…/zen/go/v1/models`), `#privacy`
- `https://opencode.ai/docs/providers/#opencode-go` — `/connect` → `OpenCode Go` → paste key from `opencode.ai/auth`; also `#credentials` (`~/.local/share/opencode/auth.json`) and `#hiding-models` (`whitelist`/`blacklist`)
- `https://opencode.ai/docs/zen/` — Zen endpoint pricing and `#endpoints`/`#models` (`https://opencode.ai/zen/v1/models`, `opencode/<model-id>` form) — structural precedent for Go
- `https://opencode.ai/zen` — Zen marketing/pricing page confirming curated-gateway model
- `https://opencode.ai/docs/server/` — `opencode serve` usage/options/spec/auth and the full `…#apis` table (Global/Project/Path/VCS/Instance/Config/Provider/Sessions/Messages/Commands/Files/Tools/LSP/…); demonstrates absence of `/v1/chat/completions` on the local server
- `https://github.com/anomalyco/opencode` — OpenCode TypeScript repo (installation, TUI+server architecture)
- `https://github.com/anomalyco/opencode-sdk-go` (+ `https://pkg.go.dev/github.com/sst/opencode-sdk-go`) — Go SDK README/usage: `go get github.com/sst/opencode-sdk-go@v0.19.2`, `opencode.NewClient(); client.Session.List`
- `https://github.com/opencode-ai/opencode` — Archived Go TUI ("Archived: Project has Moved" → `charmbracelet/crush`)
- GitHub code search results 2026-08-28 for `opencode-go` — `craft-ai-agents/craft-agents-oss#668` ("OpenCode Go is an OpenAI-compatible API endpoint …"), `anomalyco/opencode-sdk-go`, `aaif-goose/goose#8381`, `monotykamary/pi-opencode-go-provider`, `@lnilluv/pi-opencode-go-rotation` — demonstrating no repo named `sst/opencode-go` as a distinct LLM provider

Today is 2026-08-28; doc and code line numbers are pinned to that date. Re-verify `https://opencode.ai/docs/go/#endpoints` on merge day — the gateway's catalog is the only part expected to drift.
