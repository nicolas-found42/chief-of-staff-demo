# An unsupported reasoning effort resolves to the nearest advertised level

Every OpenRouter call asks for the thinking depth it was configured with — the app's default is
`low` (`DEFAULT_REASONING_EFFORT`) — and keeps the thinking itself off the wire. Until
[PR #397](https://github.com/nicolas-found42/chief-of-staff-demo/pull/397) the resolver sent
*nothing* when the model's catalogue entry did not list the requested level, on the reading that an
unadvertised value should not be asserted. That silence handed the provider its own default, and
for a thinking model the provider default is its deepest setting. Every
`nex-agi/nex-n2.5-mini:free` slot of the first #363 baseline campaign failed this way: the model
lists `high / medium / none` with default `high`, the app asked for `low`, nothing was sent, and the
model reasoned silently for minutes under a request ceiling sized for a small structured answer —
HTTP 200, keep-alive bytes only, `request_timeout` on all 21 slots.

The resolver now walks OpenRouter's effort ladder (`none, minimal, low, medium, high, max`): a
level the model advertises is sent as is; an unadvertised level resolves to the nearest advertised
one, preferring less thinking, and steps up only when nothing lower is allowed; `none` is never sent
to a model that declares reasoning mandatory; a word outside the vocabulary is still omitted. The
same replay that timed out answers in seconds.

## Consequences

The caller's intent — bounded, cheap thinking — is honoured on every model rather than only on the
ones whose vocabulary happens to include the word. One behaviour changes for models that declare
reasoning mandatory and are asked for `none`: they now receive their lowest advertised level (for
`z-ai/glm-5.3-flash`, `low` rather than the provider's `max`). A model that advertises no effort list
still receives the requested level unchanged. ADR-0074's rule that the evaluation judge runs at
`high` is unaffected: `high` is advertised wherever it is asked for.
