import type {
  AttributeValue,
  RecordedTelemetrySpan,
  SpanAttributes,
  SpanOptions,
  SpanStatus,
  TelemetryContext,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { appendFile, readFile, rm } from "node:fs/promises";

interface SpanRecord {
  id: number;
  parentId: number | null;
  name: string;
  attributes: SpanAttributes;
  events: Array<{ name: string; attributes: SpanAttributes }>;
  status: SpanStatus;
  settled: boolean;
  explicitStatus: boolean;
  endSequence?: number;
}

interface JsonlSpanLine {
  id: number;
  parentId: number | null;
  name: string;
  attributes: SpanAttributes;
  events: Array<{ name: string; attributes: SpanAttributes }>;
  status: SpanStatus;
  settled: boolean;
  endSequence?: number;
}

function copyAttributeValue(value: AttributeValue): AttributeValue {
  return Array.isArray(value) ? [...value] : value;
}

function copyAttributes(attributes: SpanAttributes | undefined): SpanAttributes {
  const copy: SpanAttributes = {};
  if (!attributes) {
    return copy;
  }
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue;
    }
    copy[name] = copyAttributeValue(value);
  }
  return copy;
}

function copyStatus(status: SpanStatus): SpanStatus {
  if (status.status === "ok") {
    return { status: "ok" };
  }
  return status.error
    ? { status: "error", error: { name: status.error.name, message: status.error.message } }
    : { status: "error" };
}

function automaticErrorStatus(error: unknown): SpanStatus {
  try {
    if (error instanceof Error) {
      return { status: "error", error: { name: error.name, message: error.message } };
    }
    const candidate = error as { name?: unknown; message?: unknown };
    if (typeof candidate?.name === "string" && typeof candidate?.message === "string") {
      return { status: "error", error: { name: candidate.name, message: candidate.message } };
    }
  } catch {
    // Fall through to a plain error status.
  }
  return { status: "error" };
}

function inertSpan(): TelemetrySpan {
  const noop = {
    startSpan: <T>(_options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>) => {
      const result = callback(noop);
      return Promise.resolve(result) as Promise<T>;
    },
    addEvent() {},
    setAttributes() {},
    setStatus() {},
  };
  return noop;
}

function runCallbackWithoutRecording<T>(
  options: SpanOptions,
  callback: (span: TelemetrySpan) => T | Promise<T>
): Promise<T> {
  const span = inertSpan();
  let result: T | Promise<T>;
  try {
    result = callback(span);
  } catch (error) {
    return Promise.reject(error);
  }
  return Promise.resolve(result);
}

/**
 * Conforming JSONL telemetry adapter: appends one line per settled span to a
 * JSONL file. Recording failures never change workflow behavior. Implements
 * the callback telemetry adapter contract validated by
 * `@earendil-works/pi-telemetry/testing` conformance cases.
 */
export class JsonlTelemetryContext implements TelemetryContext {
  private nextId = 1;
  private nextEndSequence = 1;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    return this.startSpanInternal(null, options, callback);
  }

  private startSpanInternal<T>(
    parent: SpanRecord | null | undefined,
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>
  ): Promise<T> {
    if (parent?.settled) {
      return runCallbackWithoutRecording(options, callback);
    }
    let recordedSpan: SpanRecord | null;
    try {
      recordedSpan = {
        id: this.nextId,
        parentId: parent?.id ?? null,
        name: options.name,
        attributes: copyAttributes(options.attributes),
        events: [],
        status: { status: "ok" },
        settled: false,
        explicitStatus: false,
      };
      this.nextId += 1;
    } catch {
      recordedSpan = null;
    }
    if (!recordedSpan) {
      return runCallbackWithoutRecording(options, callback);
    }

    const span: TelemetrySpan = {
      startSpan: <C>(
        childOptions: SpanOptions,
        childCallback: (childSpan: TelemetrySpan) => C | Promise<C>
      ) => this.startSpanInternal(recordedSpan, childOptions, childCallback),
      addEvent: (name, attributes) => {
        if (recordedSpan?.settled) {
          return;
        }
        try {
          recordedSpan.events.push({ name, attributes: copyAttributes(attributes) });
        } catch {
          // Passive recording: drop malformed events.
        }
      },
      setAttributes: (attributes) => {
        if (recordedSpan?.settled) {
          return;
        }
        try {
          const merged = { ...copyAttributes(recordedSpan.attributes), ...copyAttributes(attributes) };
          recordedSpan.attributes = merged;
        } catch {
          // Passive recording: keep prior attributes.
        }
      },
      setStatus: (status) => {
        if (recordedSpan?.settled) {
          return;
        }
        try {
          recordedSpan.status = copyStatus(status);
          recordedSpan.explicitStatus = true;
        } catch {
          // Passive recording: keep prior status.
        }
      },
    };

    let result: T | Promise<T>;
    try {
      result = callback(span);
    } catch (error) {
      this.settle(recordedSpan, true, error);
      return Promise.reject(error);
    }
    return Promise.resolve(result).then(
      (value) => {
        this.settle(recordedSpan as SpanRecord, false, undefined);
        return value;
      },
      (error: unknown) => {
        this.settle(recordedSpan as SpanRecord, true, error);
        throw error;
      }
    );
  }

  private settle(span: SpanRecord, failed: boolean, error: unknown): void {
    if (span.settled) {
      return;
    }
    if (failed && !span.explicitStatus) {
      span.status = automaticErrorStatus(error);
    }
    span.settled = true;
    span.endSequence = this.nextEndSequence;
    this.nextEndSequence += 1;
    const line: JsonlSpanLine = {
      id: span.id,
      parentId: span.parentId,
      name: span.name,
      attributes: span.attributes,
      events: span.events,
      status: span.status,
      settled: true,
      endSequence: span.endSequence,
    };
    const write = this.queue.then(() =>
      appendFile(this.filePath, `${JSON.stringify(line)}\n`, "utf8").catch(() => undefined)
    );
    this.queue = write;
  }

  /** Read recorded spans back in file order (settlement order). */
  async getSpans(): Promise<readonly RecordedTelemetrySpan[]> {
    await this.queue.catch(() => undefined);
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const parsed = JSON.parse(line) as JsonlSpanLine;
        return {
          id: parsed.id,
          parentId: parsed.parentId,
          name: parsed.name,
          attributes: parsed.attributes,
          events: parsed.events,
          status: parsed.status,
          settled: parsed.settled,
          ...(parsed.endSequence === undefined ? {} : { endSequence: parsed.endSequence }),
        };
      });
  }

  /** Best-effort removal of the backing file. */
  async dispose(): Promise<void> {
    await this.queue.catch(() => undefined);
    await rm(this.filePath, { force: true }).catch(() => undefined);
  }
}
