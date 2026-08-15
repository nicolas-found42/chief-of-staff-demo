import type { WorkflowEvent } from "@chief-of-staff/contracts";
import type { Workspace } from "./workspace.js";

/** Append-only workflow event sink. Every event gets a monotonic sequence
 * number; writes are serialized through an internal queue. */
export class EventSink {
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspace: Workspace,
    private readonly relativePath: string,
    private readonly clock: () => Date
  ) {}

  emit(
    event: Omit<WorkflowEvent, "sequence" | "timestamp">
  ): Promise<void> {
    const sequence = ++this.sequence;
    const line = `${JSON.stringify({ ...event, sequence, timestamp: this.clock().toISOString() })}\n`;
    const write = this.queue.then(() => this.workspace.appendText(this.relativePath, line));
    this.queue = write.catch(() => undefined);
    return write;
  }

  get nextSequence(): number {
    return this.sequence + 1;
  }
}
