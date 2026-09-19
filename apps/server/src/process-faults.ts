/**
 * Process-level fault guards (UX audit F1): an async throw that lands outside
 * every promise chain this codebase owns is fatal to Node by default. A
 * playwright-core transport message arriving on a disposed CDP session did
 * exactly that twice in one audit session, killing the app mid-research while
 * the page kept polling a dead port. A failing render must degrade to a
 * failed source read, never take the whole app down, so the guards log loudly
 * and keep serving. They are a safety net behind per-operation error handling,
 * never a replacement for it.
 *
 * Accepted tradeoff (raised in CodeRabbit's PR #458 review): Node documents
 * that resuming after `uncaughtException` can leave the process in an
 * inconsistent state, and these handlers do resume. The risk is bounded here
 * because every workspace record is written atomically — a verified rename
 * under the single store coordinator — so a mid-write fault leaves the
 * previous record intact rather than a torn one. Keep-serving is the audit's
 * own requirement (F1: "the feature destroys the application process
 * itself"); dying takes every in-flight operation with it, which is the
 * strictly worse outcome for this app.
 */
export function installProcessFaultGuards(
  log: (line: string) => void = (line) => console.error(line),
): () => void {
  const describe = (error: unknown): string =>
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  const onRejection = (reason: unknown): void => {
    log(`[fault] Unhandled rejection kept the app serving: ${describe(reason)}`);
  };
  const onException = (error: unknown): void => {
    log(`[fault] Uncaught exception kept the app serving: ${describe(error)}`);
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  };
}
