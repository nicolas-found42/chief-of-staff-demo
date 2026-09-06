# Issue #228 validation artifacts

These are diagnostic smoke runs, not evidence that issue #228's quality acceptance criteria
have passed. The configured research and judge model was OpenRouter `z-ai/glm-5.3-flash`.
All research ran in temporary workspaces.

- `fixed-documents-expanded-2d0a903133188b6a`: authoritative corrected smoke run for Achim
  Steiner and Ana Botín. Both research operations were interrupted by model extraction
  timeouts; the report is correctly **failed**, with zero recovered facts. The per-person
  operation JSON files preserve the attempts. Judge responses do not establish successful
  research when extraction failed.
- `fixed-documents-expanded-8620f6e645bedd41`: earlier diagnostic run, retained unchanged for
  traceability. Its top-level completed status is **incorrect**: both nested operations were
  interrupted. This exposed the evaluator bug fixed before the corrected run. Do not use it
  as a successful baseline or quality result.

The full 30-person fixed-document evaluation, live incumbent and expanded evaluations, and
baseline/candidate comparison remain outstanding. See
[the validation record](../../docs/research/person-benchmark-validation-2026-09-06.md).
