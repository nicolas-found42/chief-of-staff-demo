import type { WorkflowEvent } from "@chief-of-staff/contracts";
import { appendFile } from "node:fs/promises";

/** Append-only workflow event sink. Every event gets a monotonic sequence
 * number; writes are serialized through an internal queue. */
export class EventSink {
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly clock: () => Date
  ) {}

  emit(
    event: Omit<WorkflowEvent, "sequence" | "timestamp">
  ): Promise<void> {
    const sequence = ++this.sequence;
    const line = `${JSON.stringify({ ...event, sequence, timestamp: this.clock().toISOString() })}\n`;
    const write = this.queue.then(() => appendFile(this.filePath, line, "utf8"));
    this.queue = write.catch(() => undefined);
    return write;
  }

  get nextSequence(): number {
    return this.sequence + 1;
  }
}
