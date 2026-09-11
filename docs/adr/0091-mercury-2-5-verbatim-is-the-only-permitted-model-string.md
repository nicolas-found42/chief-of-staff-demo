# The Mercury model string is recorded verbatim

The permitted model string for the Person Research Benchmark and for application configuration is
`inception/mercury-2.5` exactly. No `-preview` spelling, no alias and no other substitution may be
issued for a live call or written into a record in its place.

The decision follows an observed deviation. The recovery run
`live-discovery-expanded-8ebc59982210a118` ([issue #259](https://github.com/nicolas-found42/chief-of-staff-demo/issues/259))
recorded `researchModel` and `planningModel` as `inception/mercury-2.5-preview` and issued its
research and planning calls under that string, judged by the frozen `z-ai/glm-5.3-flash`. The
merged record documents what ran and is not relabelled. The owner's correction is that the string a
run issues and records is the string the owner chose, not one that happens to resolve to the same
catalogue entry.

OpenRouter currently normalizes `inception/mercury-2.5-preview` to the entry the verbatim id
resolves to (provider Inception, 260000-token context, version label
`inception/mercury-2.5-20260908`). That equivalence is context, not a licence: a provider may
retire or repoint an alias at any time, and a record that carries two spellings for one model
cannot be read as one binding. The benchmark's arms, the application's `models[provider][purpose]`
map and every recorded provenance therefore carry the verbatim id.

## Considered Options

- **Keep the alias because it resolves to the same entry.** Rejected: resolution is the provider's
  present behaviour, not a property of the record, and the alias can be repointed with no local
  change.
- **Rewrite the preview string in the merged recovery artifacts to the verbatim id.** Rejected:
  that is relabelling a record of what ran. The artifacts stay as they are; the deviation is
  documented here and in the validation record instead.
- **Change the application's default OpenRouter model to the verbatim id.** Rejected as a
  non-sequitur: `DEFAULT_MODELS` is the app's own default choice, while this decision governs
  which string may be *issued and recorded* when Mercury is the chosen model.
- **Validate the string in the benchmark CLI's argument parsing.** Rejected as brittle: the CLI's
  binding is the config file's purpose map (`ConfigStore.getForPurpose`), so the place to check is
  the resolved bindings on the way in, not the text of a flag that could be spelled a dozen ways.

## Consequences

The #259 correction run `live-discovery-expanded-4c03326082a59064` records research, planning and
judge all as `openrouter inception/mercury-2.5` verbatim, and it is structurally unpairable with
the glm-judged incumbent: the judge model, the research and planning models and the evaluated
population all differ, so a mercury-judged comparison requires re-baselining both halves under one
judge — an owner decision about spend and scope. Records that already carry the alias stay as they
are and are read as the deviation they document. Because a run issues and records whatever its
config's purpose bindings resolve to, the cheapest check is a fail-closed preflight on those
resolved bindings before spend, and the run's own provenance is the proof of what was issued.
