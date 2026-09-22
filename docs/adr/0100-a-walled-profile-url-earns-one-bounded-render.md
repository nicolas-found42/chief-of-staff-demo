# A Profile's own walled LinkedIn URL earns one bounded anonymous render

ADR-0042 lets LinkedIn evidence enter "through public indexing or an explicitly
authorized provider". The reader has in practice gone further: `readSocial`
fetches `linkedin.com/in/<slug>` anonymously and retains a page that renders
public content, and a bounded anonymous render already supplements such a
page with article cards. On 2026-09-18 that route published dossiers for two
of #423's three profiles. The owner has now authorized it explicitly (#423,
Path B), and this record states its scope.

## The decision

When the direct anonymous read of one of the Profile's own LinkedIn profile
URLs is refused with a sign-in wall, the reader makes **one** bounded
anonymous render of that URL. The render is kept only when it lands on the
same `/in/<slug>` profile; anything else is the wall it is.

- **Only the Profile's own URLs.** A LinkedIn URL reached through discovery
  never earns the render; its walled read stays recorded as `login-required`.
- **Only a sign-in wall.** A bot challenge is never retried in a browser.
- **A render that lands on a sign-in surface is a wall**, whatever its body
  says. A LinkedIn render whose final URL is `/authwall`, `/login`, `/signup`,
  `/uas/…` or `/checkpoint/…` is rejected in `tryRender`, for every caller.
  The measured failure (2026-09-18, `sheilawarrick`) was a render that landed
  on `/authwall?…sessionRedirect=/in/<slug>` with a join form that no body
  marker caught, which would have been retained as the person's page.
- **Only the same profile.** Identity is decided from the requested URL, so a
  render that landed on another `/in/<slug>` would pass as the Profile's own
  and skip ADR-0097's subject gate. It is recorded as `identity-unmatched`
  instead; a renamed profile needs its new URL added to the Profile.
- The walled direct read is still recorded, with `recovery: alternative-route`.
  A failed render adds `rendering-failed` and the source stays `blocked`.

## What stays excluded

No login, no cookie, no imported session, no CAPTCHA or challenge
interaction, no proxy, and no retry beyond the one render. The transport's
browser-like user agent exception (`source-adapters/http.ts`) is not extended
to LinkedIn. A sign-in shell or search snippet is never the missing profile
content (ADR-0042; #423 constraint 3), and durable names still require a
corroborated substantive read (ADR-0097).

## Consequences

A walled read is not proof that a render will succeed: LinkedIn's gate varies
by client, slug and moment, and an IP-wide refusal is byte-identical to a
per-profile wall. One render per Profile URL per read adds one request to an
already-refused host; it is bounded, not retried.
