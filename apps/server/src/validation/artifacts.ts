import { rmSync, writeFileSync } from "node:fs";

/**
 * Terminal run artifacts for the eval CLIs (#363, MWR-020).
 *
 * A slot's directory holds exactly one terminal file: the run output when the
 * model answered, or the error record when it did not. Every path — including
 * a failure to serialize the output — routes through here, so a run can no
 * longer end with neither file and be scored against an earlier attempt's
 * leftovers.
 */

export class TerminalOutcomeWriteError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(
      `Could not write the terminal outcome at ${path}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "TerminalOutcomeWriteError";
  }
}

export interface TerminalRunOutcomeInput {
  outFile: string;
  errFile: string;
  /** The JSON payload for whichever file this outcome writes. */
  body: unknown;
  kind: "success" | "failure";
  writeFile?: ((path: string, contents: string) => void) | undefined;
  remove?: ((path: string) => void) | undefined;
}

export function writeTerminalRunOutcome(input: TerminalRunOutcomeInput): void {
  const write =
    input.writeFile ?? ((path: string, contents: string) => writeFileSync(path, contents));
  const remove = input.remove ?? ((path: string) => rmSync(path, { force: true }));
  const contents = `${JSON.stringify(input.body, null, 2)}\n`;
  const attempt = (path: string, action: () => void): void => {
    try {
      action();
    } catch (error) {
      throw new TerminalOutcomeWriteError(path, error);
    }
  };
  /* The order is deliberate, so the two arms are not interchangeable: a success
     writes its output before dropping a stale error record, while a failure
     drops a stale output before writing its record — a crash between the two
     calls then leaves a readable file rather than the wrong one. */
  if (input.kind === "success") {
    attempt(input.outFile, () => write(input.outFile, contents));
    attempt(input.errFile, () => remove(input.errFile));
    return;
  }
  attempt(input.outFile, () => remove(input.outFile));
  attempt(input.errFile, () => write(input.errFile, contents));
}
