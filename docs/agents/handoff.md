# Session handoffs

A handoff document (the notes one session leaves for the next) describes the repo as the
*writing* session saw it. Premises go stale fast — a branch carries new commits, a merged PR
changes the config the handoff describes.

- Every factual claim in a handoff carries the commit SHA or CI run ID it was measured at.
- The reading agent re-verifies load-bearing premises against the current HEAD before sizing
  work off them. `git show <sha>:<path>` settles whether the file changed; never size work
  from a projection built on a premise you have not re-checked.
- Projections in a handoff are hypotheses, not baselines. Measure before treating one as a
  starting number.
