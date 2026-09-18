# Engine-level blocking in our self-hosted SearXNG: brave, duckduckgo, startpage, google cse, yep

_Researched 2026-09-18 against primary sources: the SearXNG sources at the revision this
deployment actually runs (`2026.9.1-18af21159`) and at master, the SearXNG issue tracker (issue
bodies, maintainer comments, PR diffs), vendor robots.txt / ToS / API-documentation pages fetched
live, and this instance's own container logs. Motivated by the 2026-09-18 diagnosis that our
SearXNG sidecar (ADR-0049) was contributing zero results to Person Profile research: `brave`
answered HTTP 429 at the IP level, `duckduckgo` / `startpage` / `google cse` each answered an
anti-bot challenge, and `yep` answered cleanly for a while and then self-suspended with "access
denied". All five were consequently disabled in [`searxng/settings.yml`](../../searxng/settings.yml).
Companion to [anti-bot-keyless-search.md](anti-bot-keyless-search.md), which covers the app's own
direct (non-SearXNG) HTML-scrape providers (Mojeek, DuckDuckGo) and the repo's general posture -
never impersonate past a gate we were not invited through. This file does not re-decide that
posture; it documents what the SearXNG-mediated engines do, what upstream has and has not fixed,
and what the real options are._

## Verdicts at a glance

| Engine | What this instance saw | Classification | Best available fix |
|---|---|---|---|
| `brave` (HTML) | HTTP 429 `TooManyRequests` (also on plain `curl` from the same IP) | **Documented workaround exists** - merged upstream, not in our image | Upgrade SearXNG past PR #6620 (curl_cffi/Chrome TLS impersonation); or use the paid Brave Search API via the `braveapi` engine |
| `duckduckgo` (html.duckduckgo.com) | CAPTCHA page (`challenge-form`) | **Documented workaround exists, with a live caveat** - merged upstream, still IP/TLS-stack dependent | Upgrade past #6620; expect it to keep flapping from some IPs |
| `startpage` | Anubis proof-of-work challenge redirect -> `/sp/captcha` | **Documented workaround exists** - merged upstream, not in our image | Upgrade past PR #6669 (built-in PoW solver, engine ships `inactive: true`), then explicitly enable with `inactive: false` |
| `google cse` | Google "unusual traffic" anti-bot text surfaced through the engine as a 429 | **Vendor anti-abuse, not a SearXNG bug** - and *not* the documented API quota | Nothing worth doing: the keyless element surface is Google-gated, and the sanctioned JSON API is closed to new customers; keep it disabled |
| `yep` | HTTP 403 `AccessDenied` (Cloudflare-class), self-suspends after ordinary query volume | **Known upstream issue, no fix** (open since 2024; engine stock-disabled) **and** the vendor ToS forbids the keyless path | Keep it disabled; there is no upstream fix and no sanctioned keyless lane |

## The deployment under the microscope

Everything below is grounded in what this stack actually runs, not on latest master:

- **Image**: `docker.io/searxng/searxng:latest` resolves here to OCI version
  `2026.9.1-18af21159`, revision `18af21159bd7b84880cd7265b184825493322232`, built 2026-09-01
  (`docker image inspect`). Docker Hub's `latest` as of 2026-09-18 is `2026.9.18-c0042add3`
  (Docker Hub API), so the upstream fixes discussed below all post-date our image.
- **Inside this image**: `searx/engines/startpage.py` has no Anubis solver and
  `searx/network/client.py` has no `curl_cffi` import - i.e. the image predates PR #6620
  (merged 2026-09-04) and PR #6669 (merged 2026-09-10).
- **Effective suspension times** (shipped `searx/settings.yml`, read from the container):
  AccessDenied/403 **180 s**, CAPTCHA **3600 s**, TooManyRequests/429 **180 s**, Cloudflare
  CAPTCHA 15 days (1296000 s), Cloudflare firewall 24 h, reCAPTCHA 7 days. The class docstrings
  in [`searx/exceptions.py`](https://github.com/searxng/searxng/blob/18af21159bd7b84880cd7265b184825493322232/searx/exceptions.py)
  name 1-day/1-day/1-hour fallbacks, but the shipped `settings.yml` values win.
- **The wall -> verdict pipeline**: [`searx/network/raise_for_httperror.py`](https://github.com/searxng/searxng/blob/18af21159bd7b84880cd7265b184825493322232/searx/network/raise_for_httperror.py)
  raises `SearxEngineAccessDeniedException` for 402/403 and
  `SearxEngineTooManyRequestsException` for 429 (and sniffs Cloudflare/reCAPTCHA challenge
  markers); [`searx/search/processors/abstract.py`](https://github.com/searxng/searxng/blob/18af21159bd7b84880cd7265b184825493322232/searx/search/processors/abstract.py)
  `handle_exception()` records the `unresponsive_engines` `[engine, reason]` pair and applies the
  suspension. Every one of our five log entries names the same frame,
  `searx/search/processors/online.py:207` (`response = req(...)`).
- **What the five engines produced here** (verbatim `docker compose logs searxng`, window
  2026-09-15 -> 2026-09-18):

```text
searx.engines.brave      SearxEngineTooManyRequestsException  Too many request (suspended_time=180)   GET https://search.brave.com/search?q=...&source=web
searx.engines.duckduckgo SearxEngineCaptchaException         CAPTCHA (wt-wt) (suspended_time=0)      POST https://html.duckduckgo.com/html/
searx.engines.google_cse SearxEngineTooManyRequestsException 429 (suspended_time=180): "google cse: Our systems have detected unusual traffic from your network."
searx.engines.startpage  SearxEngineCaptchaException         get_sc_code: got redirected to https://www.startpage.com/sp/captcha (suspended_time=3600)
searx.engines.yep        SearxEngineAccessDeniedException     HTTP error 403 (suspended_time=180)     GET https://api.yep.com/search?query=...&safeSearch=off&limit=20
```

  `searx.engines.google` (the HTML Google engine, separately disabled) also hit a
  `SearxEngineCaptchaException` from the same IP on 2026-09-18 - same problem family,
  supporting evidence that this is IP/anti-bot enforcement and not one bad engine module.
- **What we did about it**: [`searxng/settings.yml`](../../searxng/settings.yml) sets
  `disabled: true` for exactly these five engines while `bing`, `duckduckgo web`, `yandex`,
  `swisscows`, `seznam` and `naver` stayed enabled. That file also pins
  `outgoing.enable_http2: false` (live-verified: stock HTTP/2 to www.bing.com times out from this
  container while HTTP/1.1 answers in ~150 ms) and raises the request timeouts. The app-side
  [searxng provider](../../apps/server/src/source-adapters/providers/searxng.ts) only *reports*
  what SearXNG answers (`unresponsive_engines` -> per-engine reason strings); nothing client-side
  can un-suspend an engine that has been gated upstream.

## brave

**Surface & published stance.** The engine GETs `https://search.brave.com/search?...` (see log
above); SearXNG's docs describe the standard `brave` engine and the keyed `braveapi` engine
side-by-side ([docs](https://docs.searxng.org/dev/engines/online/brave.html)). Brave's
`robots.txt` (fetched live 2026-09-18) disallows `/search` for all agents, with explicit
exceptions for a few conversational surfaces (e.g. `/search?q=...&source=sidebar`). The engine
docs also warn that going past the tested page limit "won't return any result and you will most
likely be flagged as a bot" ([same page](https://docs.searxng.org/dev/engines/online/brave.html)).

**Observed here.** `Too many request` / 429, reproduced from the container with plain `curl` as
well, including against a freshly restarted instance with no prior queries - i.e. the IP, not the
session's query volume, was already flagged.

**Upstream status.** This is one of the oldest walled engines:
issue [#4653 "Brave engine `SearxEngineTooManyRequestsException`"](https://github.com/searxng/searxng/issues/4653)
(2025) saw return42 report "on my instance the brave engine have a fail rate at 90%" (and later,
"dropped to 0%"), with maintainer unixfox answering "I guess there is nothing that can really be
done. Closing". In 2026 the picture changed: issue
[#6402 "Brave 'too many requests'"](https://github.com/searxng/searxng/issues/6402) (closed as
duplicate) points at the alternative Brave-index engine added in
[PR #6229](https://github.com/searxng/searxng/pull/6229) - "resulthunter.com uses the Brave index,
so it could be used to bypass Brave's ratelimits" - and
[PR #6620 "Migrate httpx -> curl_cffi"](https://github.com/searxng/searxng/pull/6620) (merged
2026-09-04, commit [`be836e614a2f`](https://github.com/searxng/searxng/commit/be836e614a2f2e7512e2e1915a0bc37d51ee865c))
replaced the whole HTTP client with TLS-impersonating `curl_cffi`; its description says the
requests "mimic chrome" by default. That PR also added `enable_http3 = True` to `brave.py`.
Post-merge, vojkovic asked "Can someone test if they notice the same?" and return42 answered
"Confirmed, I had some parsing errors but non SearxEngineTooManyRequestsException anymore"; the
author of #6596 also reported Brave stopped blocking "even after several consecutive searches".
`impersonate` is a per-engine *developer* parameter (default chrome, "none to disable" - see the
`params` table in [engine development docs](https://github.com/searxng/searxng/blob/master/docs/dev/engines/engine_overview.rst));
it is not configurable from `settings.yml`.

**Vendor position.** Brave publishes a sanctioned, paid lane: the
[Search API](https://api-dashboard.search.brave.com/documentation/pricing) costs **$5.00 per
1,000 requests** (prepaid, 50 rps, "free $5 in credits every month"). The
[Search API Terms of Use](https://api-dashboard.search.brave.com/terms-of-service) (last updated
2026-09-01) restricts use to the API itself and forbids, among others, "circumvent[ing] or
bypass[ing] rate limits or service limits through any method" (v), using the API to "circumvent
use of the API" (x), redistributing the Search Results (xii), and using them to train or evaluate
AI models (xiii). The HTML search surface is robots-disallowed and has no sanctioned usage.

**Classification: documented workaround exists.** Upgrading to a SearXNG release that carries
#6620 is the upstream-sanctioned mitigation; the paid `braveapi` engine is the contractually clean
one. Note the posture tension: the workaround *is* TLS impersonation, performed by SearXNG itself
(see "What this means for this repo" below).

## duckduckgo

**Surface & published stance.** The engine POSTs to `https://html.duckduckgo.com/html/`; stock
`settings.yml` enables it while `duckduckgo web` (the `duckduckgo.com` surface) is disabled
([master settings](https://github.com/searxng/searxng/blob/master/searx/settings.yml#L841-L848)).
DuckDuckGo's `robots.txt` (fetched live) disallows `/html`, `/lite` and query-string paths. No
public vendor statement about SearXNG/self-hosted use was found; robots.txt is its only published
position.

**Observed here.** The CAPTCHA dialog (`<form id="challenge-form">`) -> `SearxEngineCaptchaException`.
One deployment-relevant detail: the engine raises with **`suspended_time=0`** -
[deployed revision, duckduckgo.py:475-477](https://github.com/searxng/searxng/blob/18af21159bd7b84880cd7265b184825493322232/searx/engines/duckduckgo.py#L475-L477)
and [master](https://github.com/searxng/searxng/blob/master/searx/engines/duckduckgo.py#L466-L477)
both carry the comment "set suspend time to zero is OK --> ddg does not block the IP". So unlike
the other four, SearXNG deliberately does **not** cool this engine down: every query re-hits
`html.duckduckgo.com` and gets the challenge again while the condition lasts. Our own direct DDG
provider applies a 24 h cooldown on the app side; the two layers disagree, which is why the DDG
failure appears as "constant" in logs rather than once per suspension window.

**Upstream status.** [Issue #6596 "DuckDuckGo lately replies with captcha"](https://github.com/searxng/searxng/issues/6596)
(2026-08-30) is the canonical diagnosis. The 202 challenge is a *client-fingerprint* problem, not
a UA problem: the reporter sent the shipped Firefox UA from an httpx stack and still got 202; a
diagnoser itemized three deterministic triggers from inside the container - Firefox UA + httpx's
TLS (a plain Chrome UA with the identical request passed), httpx `shuffle_ciphers()`, and the
engine's explicit `Content-Type: application/x-www-form-urlencoded` header - and worked around all
three locally. The issue was resolved by PR #6620 (2026-09-04; thread: "Just update to the latest
version. Don't modify the settings, **don't add** `network: impersonate: firefox` - that was for a
different commit"), but the fix is environment-dependent: on 2026-09-14 user iresprite reproduced
the CAPTCHA on the official `2026.9.12-d4f00d15d` image with `curl_cffi 0.16.3` and no
`impersonate` override - "CAPTCHA (wt-wt) (suspended_time=0)", the identical log line our instance
produces - while the same image answered Brave fine; another user reports the problem vanishing
after `docker compose pull`. Note the Docker image itself lagged the merge (on merge day users
reported `latest` still serving the pre-migration `2026.9.4+15b0c8ef3`), so even "update and it's
fixed" was not uniformly true within the first hours. [Issue #6520](https://github.com/searxng/searxng/issues/6520)
(closed) is the shared discussion of the "answering the CAPTCHA" workaround and its limits - see
the startpage section, whose maintainer comment applies here too.

**Classification: documented workaround exists, with a live caveat** (network migration to
curl_cffi + modern image; residual, IP-dependent flapping remains possible).

## startpage

**Surface & published stance.** The engine POSTs to `https://www.startpage.com/sp/search`.
Startpage's `robots.txt` (fetched live) disallows `/sp/`. Its Terms of Use page is
client-rendered and yielded no extractable clause when fetched (2026-09-18); Startpage's
published machine-facing position is therefore the robots file plus the deployed gate below.

**Observed here - and verified live, not inferred.** A request to Startpage from inside this
container never reaches the application: the homepage and `/sp/search` answer an **Anubis
proof-of-work challenge** (`<script id="anubis_challenge" ...>` with `"difficulty":4`, running
Anubis v1.26.4). The engine sees the redirect to `/sp/captcha` and raises
`SearxEngineCaptchaException` (`get_sc_code`, [deployed source line 209](https://github.com/searxng/searxng/blob/18af21159bd7b84880cd7265b184825493322232/searx/engines/startpage.py#L209)).
The deployed image has no solver for this challenge.

**Upstream status - fixed upstream, deliberately inactive.** Issue
[#4950 "Startpage engine issues (to-do list)"](https://github.com/searxng/searxng/issues/4950) is
the open tracker (updated 2026-09-16); older entries ([#5244](https://github.com/searxng/searxng/issues/5244),
closed) cover the engine's brittle response parsing. The block is no longer just CAPTCHA:
maintainer vojkovic identified Anubis ("a type of PoW captcha ... this can be bypassed easily via
solving the challenges using hashlib") and **PR [#6669](https://github.com/searxng/searxng/pull/6669)
(merged 2026-09-10)** added that solver - SHA-256 proof-of-work in pure Python. Because the PoW
burns CPU per request, master ships all three Startpage engines explicitly inactive:

```yaml
- name: startpage
  engine: startpage
  ...
  inactive: true  # uses a Proof Of Work captcha https://github.com/searxng/searxng/pull/6669
```

([master settings.yml lines 2317-2336](https://github.com/searxng/searxng/blob/master/searx/settings.yml#L2317-L2336).)
In #6520 a user reported on 2026-09-05 that updating to `2026.9.6+3605a2d58` stopped the CAPTCHA
("I no longer get CAPTCHA") - though for them the failure merely changed shape: a
`startpage.py:409` `JSONDecodeError ('Extra data')` on the results JSON, which a second user
confirmed (the parsing fragility tracked in [#5244](https://github.com/searxng/searxng/issues/5244)).
The Anubis challenge is live again from our IP today, so this is not a monotonic fix; #6669's
solver is what makes the engine self-sufficient when it is. Meanwhile return42's warning in the
same issue applies to the *documented*
[captcha-answering procedure](https://docs.searxng.org/admin/answer-captcha.html) (SSH tunnel +
server-side browser): "I suspect that the method described no longer works today because your web
browser has a different fingerprint than the requests sent by SearXNG" - i.e. the built-in solver
supersedes it.

**Classification: documented workaround exists** (upgrade past #6669, then opt in with
`inactive: false`, `disabled: false`), with two costs: per-request PoW CPU and the general
IP-reputation caveat.

## google cse

**What this engine actually is.** `google cse` is not the Programmable Search JSON API. It is a
keyless scrape of Google's CSE *element* surface: the deployed engine fetches
`https://www.google.com/cse/cse.js?cx=...` to mint a `cse_tok`, then queries
`https://cse.google.com/cse/element/v1?...`, using a third-party published CSE id -
the deployed source literally carries `CX = "partner-pub-8993703457585266:4862972284"  #
blackle.com` ([deployed revision, google_cse.py](https://github.com/searxng/searxng/blob/18af21159bd7b84880cd7265b184825493322232/searx/engines/google_cse.py)).
It is enabled by default in stock settings
([master settings.yml lines 1193-1201](https://github.com/searxng/searxng/blob/master/searx/settings.yml#L1193-L1201)).

**Observed here.** Google answers the element endpoint with its standard anti-bot payload - the
string `Our systems have detected unusual traffic from your network.` is carried inside the JSON
error object - and the engine escalates that to an HTTP-429-style `TooManyRequests` (180 s
suspension; see log above). This is **not** the documented CSE quota: the quota would come with
Google's own error payloads for the JSON API (`dailyLimitExceeded`, `rateLimitExceeded`), and we
never call that API. Google's `robots.txt` (fetched live) also disallows `/search`, and
`www.google.com/sorry` is the human-facing version of the same gate.

**The sanctioned lane is closing.** Google's own
[Custom Search JSON API overview](https://developers.google.com/custom-search/v1/overview)
(updated 2026-02-18) says: "The following pricing applies only to existing Custom Search JSON API
customers until the service discontinuation on January 1, 2027. **This API is not available for
new customers.**" Existing customers get 100 free queries/day and $5 per 1,000 up to 10k/day - but
there is no path for a new deployment like ours. So the usual "pay for the API" escape hatch does
not exist for this vendor any more.

**Upstream status.** No open SearXNG issue proposes a fix for the element-surface scrape; the
related HTML engine ([#5286 "Bug: google engine"](https://github.com/searxng/searxng/issues/5286),
closed) has the same class of problem, and `google` is stock-disabled in
[master settings.yml lines 1175-1178](https://github.com/searxng/searxng/blob/master/searx/settings.yml#L1175-L1178).

**Classification: vendor anti-abuse, not a bug - and not a quota.** There is nothing to fix on
our side; the honest options are "leave disabled" or "use a CSE id we are entitled to serve
through a Google-provided API", which Google no longer sells to new customers.

## yep

**Surface & published stance.** The engine GETs `https://api.yep.com/search?query=...` (deployed
form; the older `/fs/2/search` path stopped answering and the engine was repointed in
[#6047](https://github.com/searxng/searxng/issues/6047)). The engine is
**disabled by default** in stock settings
([master settings.yml lines 696-700](https://github.com/searxng/searxng/blob/master/searx/settings.yml#L696-L700)).
Yep's own Terms of Use (§4.4, fetched live) prohibit accessing the Services "by any means other
than ... the search box" and expressly ban "automated means", "spiders, robots, crawlers, data
mining tools or the like"; a later section points at Yep's developer platform as the sanctioned
API path.

**Observed here.** HTTP 403 -> `SearxEngineAccessDeniedException`
([deployed yep.py:81](https://github.com/searxng/searxng/blob/18af21159bd7b84880cd7265b184825493322232/searx/engines/yep.py#L81)),
and, after a period of clean answers, a "self-suspended" state consistent with the Cloudflare
block below. Reproduced across an instance restart, i.e. not a session artifact.

**Upstream status - the one genuinely open engine.** [Issue #4037 "Bug: yep engine /
`SearxEngineAccessDeniedException`"](https://github.com/searxng/searxng/issues/4037) has been open
since 2024-11-23 (labels `CAPTCHA`, `bug`; last activity 2026-04-24): the endpoint answers a
Cloudflare block page ("Sorry, you have been blocked") and even a plain `curl` from the reporter's
host is blocked; maintainer Bnyro's assessment in that thread is that there is little SearXNG can
do about Cloudflare checks. [Issue #6047](https://github.com/searxng/searxng/issues/6047)
(closed, completed) fixed a *different* yep failure - an API response-shape change that made every
request a 400 and silently dropped images/news - and [#3589](https://github.com/searxng/searxng/issues/3589)
(closed) was another breakage worked around with TLS impersonation. None of these touches the
403/Cloudflare block.

**Classification: known upstream issue, no fix** (open for ~22 months; engine deliberately
disabled by default), compounded by a vendor ToS that prohibits the keyless path. Keep disabled.

## Why `bing` (and the surviving set) still answers - and why that is not permission

Bing's `robots.txt` (fetched live 2026-09-18) contains `Disallow: /search` exactly like Brave,
DuckDuckGo, Startpage and Google - yet `www.bing.com` answers this container with 10 results in
~150 ms once HTTP/1.1 is forced. Bing is also stock-disabled
([master settings.yml lines 526-529](https://github.com/searxng/searxng/blob/master/searx/settings.yml#L526-L529));
we enable it locally. The difference between Bing and the five walled engines is **enforcement,
not permission**: Bing does not (today, from this IP) gate the surface, and its sanctioned
replacement lane is gone anyway - Microsoft retired the Bing Search APIs
([Bing Web Search API overview](https://learn.microsoft.com/en-us/bing/search-apis/bing-web-search/overview)),
with agent-oriented "Grounding with Bing Search" living inside Azure AI Foundry. The practical
conclusion for the fan-out: the surviving engines are a moving target, so keep the provider set
wide and treat any individual engine's suspension as normal operation - which is exactly what the
app's `unresponsive_engines` reporting already supports.

## Mitigation knobs that actually exist upstream

- **`search.suspended_times`** - per-class suspension overrides; our effective values are the
  shipped stock ones (see above). Docs:
  [settings_search](https://docs.searxng.org/admin/settings/settings_search.html).
- **Proxies / egress IP rotation** - the only documented, engine-agnostic answer to IP-level
  blocks: `outgoing.proxies` (round-robin when more than one is listed; HTTP, HTTPS, SOCKS4,
  SOCKS5 and SOCKS5h are supported) and `outgoing.source_ips` (multiple local interfaces), plus
  per-engine `proxies:` overrides. Docs:
  [settings_outgoing](https://docs.searxng.org/admin/settings/settings_outgoing.html) and
  [settings_engines](https://docs.searxng.org/admin/settings/settings_engines.html) ("To use a
  proxy for certain engine, use the proxies option in the engine's configuration"). Nothing else
  in SearXNG changes *which IP* a vendor sees; a new IP is the only documented lever against
  fingerprint-plus-reputation blocks.
- **`disabled` vs `inactive`** - `disabled: true` removes a stock engine; `inactive: true` means
  "shipped but not started unless the operator explicitly enables it"
  ([settings_engines](https://docs.searxng.org/admin/settings/settings_engines.html)). Our
  `yandex`/`swisscows`/`seznam`/`naver` entries need both flags flipped; the post-#6669 Startpage
  engines need `inactive: false` in addition to `disabled: false`.
- **Per-engine transport controls** - `enable_http2`, `enable_http3` (added to `brave.py` by
  #6620), `retry_on_http_error`, custom `headers`/`timeout`
  ([settings_engines](https://docs.searxng.org/admin/settings/settings_engines.html)). Our
  `settings.yml` already uses `enable_http2: false` to make `bing` deterministic.
- **CAPTCHA answering** - the documented procedure (SSH SOCKS tunnel + a browser on the server,
  then solve) is [answer-captcha](https://docs.searxng.org/admin/answer-captcha.html); treat it as
  historical, per return42's caveat in #6520 (fingerprint mismatch).
- **`impersonate` (curl_cffi)** - part of the *transport migration*, not a setting: since #6620 the
  network client itself impersonates Chrome, and engine modules may set `params['impersonate']`
  ([params table](https://github.com/searxng/searxng/blob/master/docs/dev/engines/engine_overview.rst),
  "curl_cffi impersonate target (default: chrome, none to disable)"). There is no `impersonate`
  key in master `settings.yml`. The PoC-era per-engine `network: impersonate: "firefox"` override
  from PR #5476 was never merged, and #6596 explicitly warns against adding it now.

## Recommended fix per engine (with evidence)

| Engine (SearXNG name) | Classification | Recommended action here | Evidence (primary source) |
|---|---|---|---|
| `brave` | Documented workaround exists (upstream merged, absent from our image) | When we next touch the image, pin >= the release containing #6620; expect better but not guaranteed reliability; the clean alternative is `braveapi` with a paid key | [#4653](https://github.com/searxng/searxng/issues/4653), [#6402](https://github.com/searxng/searxng/issues/6402), [#6229](https://github.com/searxng/searxng/pull/6229), [PR #6620](https://github.com/searxng/searxng/pull/6620), [Brave pricing](https://api-dashboard.search.brave.com/documentation/pricing), [Brave API ToS](https://api-dashboard.search.brave.com/terms-of-service), [robots.txt](https://search.brave.com/robots.txt) |
| `duckduckgo` | Documented workaround exists, live caveat (IP/TLS-stack dependent) | Same upgrade path; do not rely on it as a primary engine. Note the engine intentionally never suspends itself (`suspended_time=0`), so failures repeat on every query | [#6596](https://github.com/searxng/searxng/issues/6596), [PR #6620](https://github.com/searxng/searxng/pull/6620), [deployed raise site](https://github.com/searxng/searxng/blob/18af21159bd7b84880cd7265b184825493322232/searx/engines/duckduckgo.py#L475-L477), [robots.txt](https://duckduckgo.com/robots.txt) |
| `startpage` | Documented workaround exists (upstream merged; ships inactive) | Upgrade past #6669, then explicitly enable (`inactive: false`) only if the CPU cost of PoW is acceptable; otherwise leave disabled | [PR #6669](https://github.com/searxng/searxng/pull/6669), [#6520](https://github.com/searxng/searxng/issues/6520), [#4950](https://github.com/searxng/searxng/issues/4950), [master settings (inactive)](https://github.com/searxng/searxng/blob/master/searx/settings.yml#L2317-L2336), [robots.txt](https://www.startpage.com/robots.txt) |
| `google cse` | Vendor anti-abuse; not a bug, not the documented quota | Keep disabled. Do not budget engineering time; the sanctionable lane (JSON API) is closed to new customers and discontinued 2027-01-01 | [CSE API overview](https://developers.google.com/custom-search/v1/overview), [google_cse.py (blackle CX)](https://github.com/searxng/searxng/blob/18af21159bd7b84880cd7265b184825493322232/searx/engines/google_cse.py), [robots.txt](https://www.google.com/robots.txt) |
| `yep` | Known upstream issue, no fix + vendor ToS prohibits keyless access | Keep disabled; no upstream fix to wait for since 2024-11 | [#4037](https://github.com/searxng/searxng/issues/4037), [#6047](https://github.com/searxng/searxng/issues/6047), [master settings (disabled)](https://github.com/searxng/searxng/blob/master/searx/settings.yml#L696-L700), [Yep Terms of Use](https://yep.com/terms) |
| `bing` (control) | Neither quota nor bug - simply not enforced from this IP yet | Keep enabled for now; its `robots.txt` stance is identical to the walled engines' | [robots.txt](https://www.bing.com/robots.txt), [master settings (disabled by default)](https://github.com/searxng/searxng/blob/master/searx/settings.yml#L526-L529), [Bing Web Search API retirement](https://learn.microsoft.com/en-us/bing/search-apis/bing-web-search/overview) |

## What this means for this repo

1. **Our image is the stale variable.** `2026.9.1-18af21159` predates both relevant upstream
   fixes (#6620 for brave/duckduckgo, #6669 for startpage). Nothing else in this research changes
   the picture: there is no user-facing SearXNG setting that un-blocks an engine, and the only
   IP-level lever upstream documents is proxies/`source_ips`.
2. **Adopting those fixes is a posture decision, not a version bump.** #6620 makes SearXNG itself
   impersonate Chrome's TLS fingerprint for *all* engines. The sibling
   [anti-bot-keyless-search.md](anti-bot-keyless-search.md) records this repo's standing posture
   for our *own* fetchers ("never impersonate past a gate we were not invited through"); extending
   that policy to the SearXNG sidecar is a maintainer call with a clear trade-off, and this file
   deliberately does not make it.
3. **The two unfixable-looking engines should stay disabled.** `google cse` is anti-bot-walled on
   a surface Google never sanctioned, with its API lane closed to new customers; `yep` has an open
   upstream bug and ToS that forbid the keyless path. Neither deserves more query budget.
4. **Current `settings.yml` behavior is already correct for the "don't impersonate" posture**:
   the five engines are disabled, and the remaining keyless set (bing, duckduckgo web, yandex,
   swisscows, seznam, naver) answers. The app's `unresponsive_engines` reporting keeps per-engine
   reasons visible, so a future gate on any of these surfaces as a degraded verdict rather than a
   silent zero.
