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
  if (input.kind === "success") {
    try {
      write(input.outFile, contents);
    } catch (error) {
      throw new TerminalOutcomeWriteError(input.outFile, error);
    }
    try {
      remove(input.errFile);
    } catch (error) {
      throw new TerminalOutcomeWriteError(input.errFile, error);
    }
    return;
  }
  try {
    remove(input.outFile);
  } catch (error) {
    throw new TerminalOutcomeWriteError(input.outFile, error);
  }
  try {
    write(input.errFile, contents);
  } catch (error) {
    throw new TerminalOutcomeWriteError(input.errFile, error);
  }
}
