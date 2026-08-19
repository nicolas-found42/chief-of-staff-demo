# Accessibility Audit: transcript-found42

**Standard:** WCAG 2.1 AA (with WCAG 2.2 target-size notes) · **Date:** 2026-08-18
**Scope:** the full web client — `/` (Runs), `/runs/:id` (Run detail), `/settings`, `/no-such-page` (catch-all), plus the shared shell and stylesheet.
**Build audited:** `main` @ `d9bca01`

---

## Summary

**Issues found: 14** | 🔴 **Critical: 2** | 🟡 **Major: 5** | 🟢 **Minor: 7**

This codebase has already had a deliberate accessibility pass, and it shows. Every colour pair
in the stylesheet passes AA with margin, reflow and text-spacing are clean, headings and
landmarks are correct, and `aria-disabled` is used in place of `disabled` specifically to protect
focus. The automated axe scan across six route states returns **zero violations**, and all 11
existing e2e accessibility tests pass.

The remaining defects are exactly the ones automation cannot see: **focus that is dropped when a
control unmounts mid-action**, **a scroll container that only a mouse can reach**, **a description
attached to an element that isn't in the accessibility tree**, and **a busy state whose dimming
takes text, borders, and the focus ring below the contrast floor**. Two are Level A failures on
the app's primary task path.

---

## Method

| Layer | What was done |
|---|---|
| Automated | `axe-core` via `@axe-core/playwright`, tags `wcag2a wcag2aa wcag21a wcag21aa best-practice`, over 6 route states — **0 violations** |
| Contrast | Every declared colour pair computed from source (relative luminance, WCAG formula), including alpha-composited `opacity: 0.55` states |
| Keyboard | Scripted tab traversal, focus tracking through async state changes, in-flight request stalling to freeze transient states |
| Reflow / zoom | 320 px viewport and 200 % root font-size on every route; per-element overflow measurement |
| Text spacing | 1.4.12 override injected (line-height 1.5, letter-spacing .12em, word-spacing .16em, para 2em), clipping measured |
| A11y tree | ARIA snapshot per route; computed `display`, roles, names, and descriptions read from the live DOM |

Manual screen-reader passes (VoiceOver / NVDA) were **not** run — see [Residual risk](#residual-risk).

---

## Findings

### Perceivable

| # | Issue | WCAG | Severity | Recommendation |
|---|---|---|---|---|
| 4 | Busy controls at `opacity: .55` fall to **2.63:1** (primary label), **3.69:1** (secondary label), **1.95:1** (border) | 1.4.3 Contrast (AA), 1.4.11 Non-text (AA) | 🟡 Major | Style the busy state with real tokens, not blanket opacity |
| 10 | `prefers-reduced-motion` block clears only `transition`, not `animation` / `scroll-behavior` | 2.3.3 (AAA) / robustness | 🟢 Minor | Add `animation` and `scroll-behavior` to the reset |

### Operable

| # | Issue | WCAG | Severity | Recommendation |
|---|---|---|---|---|
| 1 | **Focus is dropped to `<body>` when the "choose files" button unmounts during upload** | 2.4.3 Focus Order (**A**) | 🔴 Critical | Keep the button mounted; swap its label, not its existence |
| 2 | **The runs / tasks table scroller is horizontally scrollable but not keyboard-reachable** | 2.1.1 Keyboard (**A**) | 🔴 Critical | Give `.table-scroll` `tabindex="0"` + `role="region"` + a name, as `.events-log` already does |
| 6 | Drag-selecting text inside a run row navigates away and discards the selection | 2.5.2 Pointer Cancellation (**A**) | 🟡 Major | Ignore the row click when a text selection was made |
| 7 | SPA route changes move neither focus nor announcement (Runs ↔ Settings) | 4.1.3 Status Messages (AA) / practice | 🟡 Major | Focus the `<h1>` on every route, as the run page already does |
| 8 | No skip link; `<main>` has no id to target | 2.4.1 Bypass Blocks (A) | 🟢 Minor | Add a visually-hidden skip link (see note on conformance below) |
| 9 | `.run-link` renders **163 × 34 px** — under the 44 px bar the project enforces elsewhere | 2.5.8 (AA, 24px) ✅ / 2.5.5 (AAA, 44px) ❌ | 🟢 Minor | Raise padding to 44 px; add `a[href]` to the target-size test |

### Understandable

| # | Issue | WCAG | Severity | Recommendation |
|---|---|---|---|---|
| 3 | **The "choose files" button has no programmatic description** — the accepted formats/size text is bound to a `display:none` input that is absent from the a11y tree | 3.3.2 Labels or Instructions (**A**) | 🟡 Major | Move `aria-describedby="upload-formats"` onto the button |
| 11 | Switching provider silently rewrites the Model field with no announcement | 3.2.2 On Input (A) — borderline | 🟢 Minor | Announce the change in a live region |
| 13 | On invalid poll interval, focus moves at the same instant the `role="alert"` banner mounts, which can truncate the announcement | 3.3.1 Error Identification (A) | 🟢 Minor | Move focus on the next frame |

### Robust

| # | Issue | WCAG | Severity | Recommendation |
|---|---|---|---|---|
| 5 | A single `busy` flag marks **all three** Settings buttons `aria-disabled` — pressing "Sync now" reports "Save settings" and "Connect Google" as disabled | 4.1.2 Name, Role, Value (A) | 🟡 Major | Scope busy state per-action |
| 12 | The runs live region is mounted already containing text; initial content in a live region is not announced | 4.1.3 Status Messages (AA) | 🟢 Minor | Render the region empty on first paint, then fill it |
| 14 | The e2e test guarding the file input's description asserts a no-op (the element is not exposed to AT) | — (test quality) | 🟢 Minor | Retarget the assertion at the button |

---

## Detailed findings

### 🔴 1. Focus is dropped to `<body>` when the upload button unmounts — 2.4.3 (Level A)

`apps/web/src/pages/RunsPage.tsx:81-101`

The "choose files" button lives inside the `uploading ? … : …` ternary, so the moment an upload
starts, the button the user just activated is removed from the DOM. Focus has nowhere to go and
falls to `<body>` — the keyboard user is thrown to the top of the document mid-task.

Confirmed live, twice:

```
BEFORE upload, focus = button.linklike:"choose files"
DURING upload, focus = <BODY — FOCUS LOST>
```

```
after failed upload: { "focus": "BODY.-", "isBody": true, "alert": "boom" }
```

On the happy path with exactly one file this is masked — the app navigates to the run detail page,
which focuses its `<h1>`. It is **not** masked when the upload fails, or when more than one file is
uploaded. In both cases the user is left on `<body>` with a `role="alert"` they must then hunt for.

This is the same defect class the project already fixed for `disabled` buttons — the CSS comment at
`apps/web/src/styles.css:256-258` explains it precisely. The dropzone simply has an unguarded copy
of the same problem.

**Fix** — keep the control mounted and change its label:

```jsx
<p>
  <strong>Drop transcripts here</strong> or{" "}
  <button
    type="button"
    className="linklike"
    aria-describedby="upload-formats"
    aria-disabled={uploading}
    onClick={(event) => {
      event.stopPropagation();
      if (uploading) return;
      inputRef.current?.click();
    }}
  >
    {uploading ? "Uploading…" : "choose files"}
  </button>
</p>
```

---

### 🔴 2. The table scroller cannot be reached or scrolled by keyboard — 2.1.1 (Level A)

`apps/web/src/styles.css:272-284`, `apps/web/src/pages/RunsPage.tsx:132`, `apps/web/src/pages/RunDetailPage.tsx:170`

`.table-scroll` sets `overflow-x: auto` with a `min-width: 34rem` table inside. Below roughly
640 px — which is exactly where a 400 % zoom user lives — the container genuinely scrolls, but it
carries no `tabindex`, so a keyboard-only user cannot scroll it and **cannot reach the Status or
Tasks columns at all**.

Measured at a 320 px viewport:

```json
{ "cls": "table-scroll", "scrollable": true, "overflowX": "544>288", "tabindex": null, "role": null }
```

The project already knows the remedy — `.events-log` and `.artifact-pre` both carry
`tabIndex={0}` with `role="region"` and a name, with a comment citing 2.1.1
(`RunDetailPage.tsx:225-232`). The table scrollers were missed.

**Fix** — apply the same treatment:

```jsx
<div className="table-scroll" tabIndex={0} role="region" aria-labelledby="runs-heading">
```

with `<h1 id="runs-heading">Runs</h1>`. (Chrome ships automatic keyboard-scrollable regions behind
a flag; do not rely on it.)

---

### 🟡 3. The upload button's format/size instructions never reach assistive tech — 3.3.2 (Level A)

`apps/web/src/pages/RunsPage.tsx:103-121`

The `#upload-formats` paragraph (`.txt · .md · .json · .pdf · .docx — up to 10 MB each`) is bound
via `aria-describedby` to the file `<input>`. That input carries the `hidden` attribute, so it
computes to `display: none` and is **absent from the accessibility tree entirely** — its
`aria-label` and `aria-describedby` are inert. The only control a user can actually reach is the
button, and it has no description:

```json
{ "inputDisplay": "none", "inputHidden": true,
  "inputAriaDescribedby": "upload-formats",
  "btnText": "choose files", "btnAriaDescribedby": null }
```

The ARIA snapshot confirms the button is exposed as a bare `button "choose files"`, with the
formats text sitting nearby as an unassociated `paragraph`. A screen reader user tabbing to the
button is told only "choose files" — not what it accepts, nor the 10 MB ceiling they are about to
trip over.

The comment at `RunsPage.tsx:103-105` reasons carefully about keeping `#upload-formats` mounted so
the reference never dangles — correct instinct, but the reference it protects was never live.

**Fix:** put `aria-describedby="upload-formats"` on the `<button>` (as shown in finding 1). Keep it
on the input too if you like; it costs nothing but does nothing.

---

### 🟡 4. The busy state dims text, borders, and the focus ring below AA — 1.4.3 / 1.4.11 / 2.4.7

`apps/web/src/styles.css:259-263`

`opacity: 0.55` composites the *entire* element — label, fill, border, and outline — against the
page. Measured against real backdrops:

| Busy control | Rendered pair | Ratio | Required | |
|---|---|---|---|---|
| `Saving…` label on primary fill | `#fafbfd` on `#829ecc` | **2.63:1** | 4.5:1 | ❌ |
| `Sync now` / `Connect Google` label | `#81858f` on `#ffffff` | **3.69:1** | 4.5:1 | ❌ |
| …their border | `#b6bac2` on `#ffffff` | **1.95:1** | 3:1 | ❌ |
| `Retrying…` label in error banner | `#7e7982` on `#fcf2f2` | **3.87:1** | 4.5:1 | ❌ |
| …its border | `#b4aeb5` on `#fcf2f2` | **1.98:1** | 3:1 | ❌ |
| **Focus ring** on busy primary | `#829ecc` on `#f4f6fa` | **2.52:1** | 3:1 | ❌ |
| **Focus ring** on busy secondary | `#87a2ce` on `#ffffff` | **2.60:1** | 3:1 | ❌ |
| **Focus ring** on busy Retry | `#8495c1` on `#f9e3e3` | **2.43:1** | 3:1 | ❌ |

The focus-ring rows are the serious half. Confirmed live — the focused busy button reports
`outline: solid 2px rgb(36,86,166)` at `opacity: 0.55`, so the ring is composited down with
everything else. The project deliberately keeps these buttons focusable (correctly, per the
comment at `styles.css:256-258`) — but the indicator marking where focus *is* fails 2.4.7/1.4.11
for the entire duration of the request.

The 1.4.3 "inactive user interface component" exemption is a poor fit here: these controls stay in
the tab order, stay focusable, and their label is **live status text** ("Saving…", "Retrying…") that
a user needs to read. That is not an inactive control.

**Fix** — style the state explicitly instead of dimming the composite:

```css
button:disabled,
button[aria-disabled="true"] {
  cursor: default;
  background: var(--surface-alt);
  color: var(--muted);          /* 5.50:1 on --surface-alt */
  border-color: var(--line-strong); /* 3.57:1 */
}

button.primary[aria-disabled="true"] {
  background: #5c7fbd;          /* keeps white text ≥ 4.5:1 */
  border-color: #5c7fbd;
  color: var(--accent-ink);
}
```

No `opacity`, so the focus ring keeps its full 6.56:1.

---

### 🟡 5. One `busy` flag disables three unrelated buttons — 4.1.2

`apps/web/src/pages/SettingsPage.tsx:33, 291, 358, 389`

`busy` is a single page-level flag shared by `save()`, `connectGoogle()`, and `syncFireflies()`.
Pressing any one of them reports all three as disabled. Captured mid-save:

```json
[ { "text": "Connect Google", "ariaDisabled": "true", "opacity": "0.55" },
  { "text": "Sync now",       "ariaDisabled": "true", "opacity": "0.55" },
  { "text": "Saving…",        "ariaDisabled": "true", "opacity": "0.55", "focused": true } ]
```

A screen reader user who tabs to "Connect Google" during an unrelated Fireflies sync is told it is
dimmed/unavailable, which is not true of any real constraint. Combined with finding 4, three
controls sit below contrast minimums at once.

**Fix:** track state per action (`saving`, `connecting`, `syncing`) and bind each button to its own.

---

### 🟡 6. Drag-selecting inside a run row navigates away — 2.5.2 (Level A)

`apps/web/src/pages/RunsPage.tsx:139-144`

The `onClick` on `<tr>` fires on the nearest common ancestor of mousedown and mouseup. Dragging to
select a filename therefore lands on the row and navigates. Confirmed:

```
after drag-select inside a row, url = http://127.0.0.1:4319/runs/run_20260818-235945_66be3b24
selection = (empty)
```

Users cannot copy a filename out of the table, and a user with a tremor or imprecise pointer who
presses down and drifts before release still triggers navigation — the "move away to abort"
escape hatch 2.5.2 is built around does not exist inside the row.

**Fix:**

```jsx
onClick={() => {
  if (!window.getSelection()?.isCollapsed) return;
  navigate(`/runs/${run.id}`);
}}
```

---

### 🟡 7. Route changes announce nothing and move no focus — 4.1.3 / practice

`apps/web/src/App.tsx:18-30`

Navigating Runs ↔ Settings updates `document.title` (2.4.2 is satisfied — `useTitle.ts` is correct)
but leaves focus on the nav link and produces no announcement. Confirmed:

```
after nav to /settings, focus = a.active:"Settings"
title = Settings · Transcript → Tasks
live regions on /settings: [ 'span[status] "Not connected"', 'span[status] ""' ]
```

Neither live region describes the route. A screen reader user hears nothing between activating the
link and manually exploring the new page. `RunDetailPage` already solves this by focusing its
`<h1 tabIndex={-1}>` on arrival (`RunDetailPage.tsx:47-56`) — the pattern just isn't applied to the
other two routes.

No single 2.1 AA criterion mandates focus movement on client-side navigation, so this is
best-practice rather than a clean-cut failure — but it is the single largest gap between this app
and a screen-reader-comfortable SPA.

**Fix:** hoist the heading-focus pattern into a shared `usePageFocus()` hook and call it from every
page, or add a route announcer to the shell.

---

### 🟢 Minor findings

**8 — No skip link.** `App.tsx` has no bypass mechanism and `<main>` has no `id`. With only two nav
links before `<main>`, and a `main` landmark present, 2.4.1 is arguably already met via landmark
navigation (axe agrees). Still worth the four lines, since screen-magnifier users without landmark
shortcuts re-traverse the header on every page.

**9 — `.run-link` target size.** Measured **163 × 34 px** (`styles.css:336-342`). Note the levels:
44 × 44 px is **2.5.5 Target Size, Level AAA** in WCAG 2.1 — *not* AA, contrary to some checklists.
The AA bar is WCAG 2.2's **2.5.8 Target Size (Minimum), 24 × 24 px**, which this link passes. It is
listed because the project holds *itself* to 44 px in `tests/e2e/a11y.spec.ts:190-207` — and that
test's selector (`button:not(.linklike), select, input:not([type=checkbox]), .checkbox-label`)
**omits `a[href]` entirely**, so no link is ever measured. Raise `.run-link` padding to `0.65rem 0`
and add `a[href]` to the selector.

**10 — Reduced motion.** `styles.css:593-597` resets `transition` only. There are no animations
today, so nothing fails now; adding `animation: none !important` and `scroll-behavior: auto`
prevents the gap from reappearing.

**11 — Silent model rewrite.** `SettingsPage.tsx:105-117` — changing Provider rewrites the Model
field's value. A sighted user sees it; a screen reader user gets no notification that a field they
did not touch now holds different text. Announce it via the existing `role="status"` pattern.

**12 — Live region ships with content.** `RunsPage.tsx:125-127` mounts
`<p role="status">` already containing "Loading runs…". Live regions must exist *before* content
enters to announce reliably; text present at mount is generally skipped. Render empty on first
paint, then populate.

**13 — Alert/focus race.** `SettingsPage.tsx:122-127` calls `setError(...)` and `.focus()` in the
same tick. Moving focus as a `role="alert"` mounts can cut the announcement short in several
SR/browser pairs. Defer the focus call with `requestAnimationFrame`. The field's own
`aria-invalid` + `aria-describedby` wiring is excellent and covers the user either way.

**14 — A test that asserts nothing.** `tests/e2e/a11y.spec.ts:151-167` verifies the file input keeps
`aria-describedby="upload-formats"` during upload. Because that input is `display:none`, the
assertion passes without exercising any user-facing behaviour (finding 3). Retarget it at the
button once the description moves.

---

## Colour Contrast Check

Every **static** pair passes, most with real margin. Computed from `styles.css` via the WCAG
relative-luminance formula.

| Element | Foreground | Background | Size | Ratio | Required | Pass |
|---|---|---|---|---|---|---|
| Body text | `#1a2233` | `#f4f6fa` | 15px | 14.70:1 | 4.5:1 | ✅ |
| Body text on card | `#1a2233` | `#ffffff` | 15px | 15.90:1 | 4.5:1 | ✅ |
| `.muted` on page | `#5a6478` | `#f4f6fa` | 15px | 5.50:1 | 4.5:1 | ✅ |
| `.muted` on card | `#5a6478` | `#ffffff` | 15px | 5.95:1 | 4.5:1 | ✅ |
| Table `th` | `#5a6478` | `#ffffff` | 12.8px | 5.95:1 | 4.5:1 | ✅ |
| `.field-hint` | `#5a6478` | `#ffffff` | 12.8px | 5.95:1 | 4.5:1 | ✅ |
| Footer text | `#5a6478` | `#ffffff` | 13.6px | 5.95:1 | 4.5:1 | ✅ |
| `.run-link` | `#2456a6` | `#ffffff` | 15px | 7.10:1 | 4.5:1 | ✅ |
| `.run-link` (row hover) | `#2456a6` | `#f4f6fa` | 15px | 6.56:1 | 4.5:1 | ✅ |
| `.linklike` on dragging zone | `#2456a6` | `#e3ecf9` | 15px | 5.96:1 | 4.5:1 | ✅ |
| Nav current / primary btn | `#ffffff` | `#2456a6` | 15px | 7.10:1 | 4.5:1 | ✅ |
| `.status-done` | `#186a35` | `#e3f2e8` | 12.8px | 5.75:1 | 4.5:1 | ✅ |
| `.status-failed` | `#a32a2a` | `#f9e3e3` | 12.8px | 5.86:1 | 4.5:1 | ✅ |
| `.status-skipped` | `#5a6478` | `#eceef2` | 12.8px | 5.12:1 | 4.5:1 | ✅ |
| `.status-active` | `#2456a6` | `#e3ecf9` | 12.8px | 5.96:1 | 4.5:1 | ✅ |
| `.source-badge` | `#5a6478` | `#f4f6fa` | 12px | 5.50:1 | 4.5:1 | ✅ |
| `.source-fireflies` | `#6b3fa0` | `#f3ecfa` | 12px | 6.40:1 | 4.5:1 | ✅ |
| `.source-watch` | `#8a5a00` | `#fdf3e0` | 12px | 5.38:1 | 4.5:1 | ✅ |
| `.banner-error` | `#a32a2a` | `#f9e3e3` | 15px | 5.86:1 | 4.5:1 | ✅ |
| `.banner-warn` | `#8a5a00` | `#fdf3e0` | 15px | 5.38:1 | 4.5:1 | ✅ |
| `.banner-ok` | `#186a35` | `#e3f2e8` | 15px | 5.75:1 | 4.5:1 | ✅ |
| `.field-error` | `#a32a2a` | `#ffffff` | 12.8px | 7.19:1 | 4.5:1 | ✅ |
| `.ok` "Connected" | `#186a35` | `#ffffff` | 15px | 6.66:1 | 4.5:1 | ✅ |
| `.bad` "failed stage" | `#a32a2a` | `#f4f6fa` | 15px | 6.64:1 | 4.5:1 | ✅ |
| **Non-text — 1.4.11** | | | | | | |
| Input / button border | `#7b8290` | `#ffffff` | — | 3.86:1 | 3:1 | ✅ |
| Input / button border on page | `#7b8290` | `#f4f6fa` | — | 3.57:1 | 3:1 | ✅ |
| Dropzone dashed border | `#7b8290` | `#ffffff` | — | 3.86:1 | 3:1 | ✅ |
| Focus ring on page | `#2456a6` | `#f4f6fa` | — | 6.56:1 | 3:1 | ✅ |
| Focus ring on card | `#2456a6` | `#ffffff` | — | 7.10:1 | 3:1 | ✅ |
| Focus ring in error banner | `#2456a6` | `#f9e3e3` | — | 5.79:1 | 3:1 | ✅ |
| Focus ring on primary fill | inset `#ffffff` | `#2456a6` | — | 7.10:1 | 3:1 | ✅ |
| **Busy state — see finding 4** | | | | **1.95–3.87:1** | 3:1 / 4.5:1 | ❌ |

The `--line-strong` token is documented in-source with its own margin analysis
(`styles.css:5-8`) — that comment is accurate.

---

## Keyboard Navigation

Tab order captured live from the top of each document.

| Route | Order observed | Enter / Space | Escape | Notes |
|---|---|---|---|---|
| `/` | Runs → Settings → choose files → run link × N | Activates | — | ✅ Logical, matches visual order |
| `/` narrow | same | — | — | ❌ Table scroller skipped entirely (finding 2) |
| `/runs/:id` | back link → retry → events log → summary → transcript | Activates; `<details>` toggles | — | ✅ Scrollable regions focusable |
| `/settings` | provider → model → api key → … → Save | Activates | — | ✅ 12-deep traversal, ring visible at every stop |
| Modals | none in app | — | — | ✅ No focus traps possible |

| Focus event | Behaviour | Verdict |
|---|---|---|
| Arriving at a run | Moves to `<h1 tabIndex=-1>`, ring visible | ✅ Exemplary |
| Retry button unmounts | Falls back to heading via `isConnected` check | ✅ Exemplary |
| Save / Sync pressed | Stays on the button (`aria-disabled`, not `disabled`) | ✅ Exemplary |
| Invalid poll interval | Moves to the offending field | ✅ (minor race, finding 13) |
| **Upload starts** | **Falls to `<body>`** | ❌ **Finding 1** |
| **Upload fails** | **Falls to `<body>`** | ❌ **Finding 1** |
| Route change Runs ↔ Settings | Stays on nav link, nothing announced | ⚠️ Finding 7 |

---

## Screen Reader (inferred from the ARIA tree — not a live SR pass)

| Element | Announced as | Issue |
|---|---|---|
| Header / nav / main / footer | `banner`, `navigation`, `main`, `contentinfo` | ✅ Full landmark set on every route |
| Runs table | `table "Transcript runs, newest first. Open a run from the link in its Created column."` | ✅ Caption tells the user where the link is |
| Column headers | `columnheader "Created" / "Source" / …` | ✅ `scope="col"` throughout |
| Run status | "Status: done" via `role="status"` + visually-hidden prefix | ✅ Correct |
| Run list summary | "3 runs, 1 in progress" | ✅ Quiet unless counts change; ⚠️ initial value likely missed (finding 12) |
| Settings cards | `group` labelled by its `<h2>` | ✅ Disambiguates the three "API key" fields |
| Poll interval when invalid | "invalid data… Enter a whole number of minutes — 1 or more" | ✅ Model wiring of `aria-invalid` + `aria-describedby` |
| Secret fields | "Stored (…). Leave blank to keep it." | ✅ Persistent hint, not a placeholder |
| External source link | "source, opens in a new tab" | ✅ `aria-hidden` on the ↗ glyph |
| **"choose files" button** | **"choose files"** — no formats, no size limit | ❌ **Finding 3** |
| **Settings buttons during any request** | **all three "dimmed"** | ❌ **Finding 5** |
| Route change | *(silence)* | ⚠️ Finding 7 |

---

## What already passes

Worth recording, because these are the parts not to regress:

- **axe-core: 0 violations** across `/`, a run detail page, `/settings`, both Google banner states, and the 404 route.
- **Reflow (1.4.10):** no horizontal page scroll at 320 px on any route — `documentElement.scrollWidth === clientWidth === 320`. Wide tables scroll inside their own container (which is why finding 2 matters).
- **Resize text (1.4.4) / Zoom:** body font in `rem`; at 200 % root font-size, `/settings` produces no horizontal scroll.
- **Text spacing (1.4.12):** with the full override applied, page height grows 1304 → 1474 px and **zero** elements clip.
- **Page titles (2.4.2):** every route sets a distinct title, including the 404 catch-all — a genuinely uncommon detail to get right.
- **Headings (1.3.1):** exactly one `<h1>` per route, no skipped levels, `<h2>` groups labelled.
- **Forms (3.3.2):** every input has a real `<label htmlFor>`; hints are persistent text, never placeholders.
- **Error identification (3.3.1):** in-page, persistent, `aria-invalid`-linked — deliberately not native validation bubbles.
- **Use of colour (1.4.1):** status pills carry text labels; the current nav item is keyed off `aria-current`, with a `forced-colors` fallback so it survives Windows High Contrast.
- **Focus visible (2.4.7):** `:focus-visible` rings everywhere, with an inset ring on accent-filled controls so the ring doesn't blend into its own fill.
- **Target size:** every button, select, text input and checkbox label clears 44 px (checkboxes get there via the wrapping label).
- **No focus traps, no autoplaying media, no time limits, no motion.**
- **1.3.5 Identify Input Purpose:** N/A — no field collects information *about the user*; API keys and paths are not among the 53 defined input purposes.

---

## Priority Fixes

1. **Keep the upload button mounted (finding 1)** — Affects every keyboard and screen reader user on the app's primary task; silently strands them at `<body>` on multi-file uploads and on every failure. ~5 lines, and it also fixes finding 3 in the same edit.
2. **Make the table scrollers focusable (finding 2)** — Affects keyboard-only users at high zoom or narrow viewports; today the Status and Tasks columns are unreachable for them. Copy the pattern already used by `.events-log`. ~1 line × 2 sites.
3. **Replace `opacity: .55` with explicit busy tokens (finding 4)** — Affects low-vision users during every save, sync, and retry, and takes the focus indicator itself below 3:1. CSS-only.
4. **Describe the upload button (finding 3)** — One attribute move; without it screen reader users meet the 10 MB limit as an error rather than an instruction.
5. **Scope the `busy` flag per action (finding 5)** — Removes a false disabled state from two controls on every request.
6. **Guard the row click against text selection (finding 6)** — Restores copyable filenames and gives imprecise pointers an escape.
7. **Focus the `<h1>` on every route (finding 7)** — Generalises a pattern the run page already implements.
8. **Minor polish (8–14)** — skip link, `.run-link` padding, reduced-motion completeness, live-region timing, and the two test corrections.

### Suggested test additions

The existing suite is unusually good but has three blind spots that let these through:

```js
// 1. Links are never measured for target size — a11y.spec.ts:193
const selector = 'a[href], button:not(.linklike), select, input:not([type="checkbox"]), .checkbox-label';

// 2. No test asserts focus survives an upload
await btn.focus();
await page.setInputFiles('input[type="file"]', sample);   // with the request stalled
await expect(btn).toBeFocused();

// 3. No test asserts scrollable containers are reachable
const unreachable = [...document.querySelectorAll('.table-scroll, .events-log, .artifact-pre')]
  .filter(e => (e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight)
            && e.tabIndex < 0);
expect(unreachable).toEqual([]);
```

A contrast assertion over the `aria-disabled` state would also have caught finding 4, since axe
does not evaluate `opacity`-composited colours.

---

## Residual risk

This audit is static analysis plus scripted browser instrumentation. It does **not** substitute for:

- **A real screen reader pass** (VoiceOver + Safari, NVDA + Firefox). Live-region timing, the
  `role="status"` polling behaviour on the runs list, and the `<details>`/`role="region"` transcript
  in particular behave differently across SR/browser pairs than the ARIA tree suggests.
- **Voice control** (Dragon, Voice Control) — "click choose files" should work, but the row-click
  behaviour in finding 6 is worth re-testing there.
- **Testing with users who rely on these tools**, which remains the only way to find the problems no
  checklist encodes.

Nothing in the audit depends on network access, the LLM provider, or a connected Google account;
all findings were reproduced against the mock provider with an isolated workspace.
