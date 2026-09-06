# Person benchmark: creative, cultural and historical reference facts (#242)

Authored 2026-09-06 for issue #242. Adds dated `creative-records` and
`historical-evidence` reference facts for all six assigned Benchmark People
(bong-joon-ho, chimamanda-ngozi-adichie, ana-botin, minouche-shafik,
ngozi-okonjo-iweala, xavier-huillard). Nothing existing was removed or
weakened: the diff is additions plus `referenceVersion` bumps only.

New corpus version: `9cd085eed4c639f6` (30 people, zero REJECTED lines from
`scripts/person-research-benchmark.mts --corpus-coverage`).

## Per-person additions

| Person | Added documents (family — source, capture/publication date) | Added facts |
|---|---|---|
| Bong Joon-ho | BFI film catalogue page for Parasite (`creative-records` — BFI, archived capture 2025-01-15); Yonhap Cannes report (`historical-evidence` — Yonhap News Agency, 2019-05-25) | `bfi-parasite-catalogue` (2019 catalogue listing, r16, beyond-coverage); `palme-or-first-korean` (first Korean Palme d'Or, r14) |
| Chimamanda Ngozi Adichie | Open Library edition record OL25428864M for Americanah (`creative-records` — Open Library, 2013); TED talk catalogue page (`creative-records` — TED, July 2009); MacArthur fellow page (`historical-evidence` — MacArthur Foundation, 2008-01-27) | `americanah-first-edition` (Knopf 2013 hardcover, r16); `single-story-talk-record` (TEDGlobal July 2009, r16+r8); `macarthur-2008-citation` (2008 fellow citation naming Half of a Yellow Sun (2006), r14) |
| Ana Botín | EBF presidential appointment release (`historical-evidence` — EBF, 2021-02-18); IIF chair-election release (`historical-evidence` — IIF, 2022-10-13) | `ebf-president-term` (two-year term succeeding Mustier, r15); `iif-chair-first-woman` (first woman IIF chair, from Jan 2023, r15) |
| Minouche Shafik | UK government appointment announcement (`historical-evidence` — GOV.UK/HM Treasury, 2014-03-18); Bank of England past-people biography (`historical-evidence` — Bank of England, archived capture 2024-05-23) | `boe-tenure-archive` (Deputy Governor 2014-08-01–2017-02-28, r7+r11, beyond-coverage); `imf-dfid-before-boe` (IMF 2011–2014, DFID 2008–2011, r7+r17, beyond-coverage); unjustified `boe-deputy-current` (stale-as-current) |
| Ngozi Okonjo-Iweala | WTO Director-General appointment record (`historical-evidence` — WTO, 2021-02-15); Paris Club Nigeria treatment record (`historical-evidence` — Paris Club, 2005-06-29) | `wto-appointment-record` (takes office 1 March 2021, r7+r14); `paris-club-2005-record` (29 June 2005 agreement + her FM-led negotiations, r1+r2, second support reuses the existing validated debt quote); unjustified `finance-minister-current` (stale-as-current) |
| Xavier Huillard | 17 April 2025 governance press release (`historical-evidence` — VINCI, 2025-04-17); dated career profile (`historical-evidence` — Batiweb, 2026-04-15) | `ceo-role-ended-2025` (role split 1 May 2025, r7+r11); `pdg-since-2010-profile` (PDG from 6 May 2010, pre-2006 Sogea/VINCI path, r7); unjustified `pdg-current` (stale-as-current) |

## Former-vs-current distinctions (required, three delivered)

1. **Huillard (sharpest):** `ceo-role-ended-2025` carries
   `effectiveTo: 2025-04-30` — VINCI split the chairman/CEO roles with effect
   1 May 2025; Huillard continues as Chairman only, Pierre Anjolras is CEO.
   Unjustified `pdg-current` lets the evaluator penalise any dossier still
   presenting him as PDG. Note this supersedes the posture of the pre-existing
   `vinci-pdg` fact (chairman *and* chief executive since 2010), which is left
   untouched per the additive-only rule.
2. **Shafik:** `boe-tenure-archive` carries `effectiveTo: 2017-02-28` from the
   Bank's own past-people archive, against her current Chief Economic Adviser
   role (existing `chief-economic-advisor` fact). Unjustified
   `boe-deputy-current` marks the stale present-tense claim.
3. **Okonjo-Iweala:** `paris-club-2005-record` anchors the reform-era
   finance-minister negotiations in a contemporaneous 2005 institutional
   record, against the WTO Director-General role (existing `wto` fact plus new
   `wto-appointment-record`). Unjustified `finance-minister-current` marks the
   stale present-tense claim.

## Left-honest list

Empty. Every assigned person had genuine, fetchable, dated catalogue or
archival evidence, so no one needed to stay untouched. No fact was invented to
fill a checklist: each excerpt was retained quote-verbatim from a fetched page
(excerpts are contiguous runs of source lines; every support quote is a full
source line, so loader containment holds by construction), and each
`publishedAt` is either stated on the source or, for the two undated
institutional pages (BFI catalogue, BoE past-people biography), the dated
Wayback capture the excerpt was retained from, recorded as such in the
document note.

## Method notes

- Primary catalogues preferred: BFI film page, Open Library edition JSON,
  TED talk page, MacArthur fellow listing.
- Institutional/government archives preferred for history: GOV.UK news story,
  Bank of England past-people archive, WTO news series, Paris Club news
  archive, VINCI press room, EBF/IIF media centres, dated trade press for the
  early-career arc no primary page states with a date.
- PDF-only sources (Santander 2014 press PDF, VINCI 2010 AGM record) were
  deliberately avoided: no PDF text tooling in the harness, and every needed
  date was available in fetchable HTML.
- Facts whose end-date evidence requires a web-archive capture are marked
  `beyond-current-coverage` with a note; all live-dated sources are
  `app-supported`.
- File partition respected: only the six assigned `people/*.json` files
  edited, plus this new doc. Reference versions bumped
  (.2→.3 for bong-joon-ho and chimamanda-ngozi-adichie; .1→.2 for the rest).

## Verification

- `pnpm exec tsx scripts/person-research-benchmark.mts --corpus-coverage`:
  corpus `9cd085eed4c639f6`, 30 people, zero REJECTED lines.
- Narrow gate
  `tests/src/modules/person-benchmark-collection.test.ts`
  `tests/src/modules/person-benchmark.test.ts`: 2 files, 17 tests, all pass.
  (Note: the issue text names `tests/src/unit/person-benchmark.test.ts`,
  which does not exist; the unit suite lives under `tests/src/modules/`.)
- `pnpm run check` green before the PR (see PR body).
