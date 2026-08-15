import {
  CALENDAR_TOOL_NAME,
  EXTRACTION_TOOL_NAME,
  ExtractedTaskSchema,
  Type,
  validateBranchInvariants,
  type CalendarEvents,
  type ExtractedTask,
} from "@chief-of-staff/contracts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { readFile } from "node:fs/promises";
import { findFreeWindows } from "../calendar.js";

export interface ExtractionCapture {
  tasks: ExtractedTask[];
  submissionCount: number;
}

/**
 * The single structured-output tool of the extraction agent. Validates branch
 * invariants, captures the tasks, and performs no filesystem writes.
 */
export function createSubmitTasksTool(capture: ExtractionCapture): AgentTool {
  return {
    name: EXTRACTION_TOOL_NAME,
    label: "Submit extracted tasks",
    description:
      "Submit the array of tasks extracted from the meeting notes. Call this tool exactly once with every extracted task.",
    parameters: Type.Object({
      tasks: Type.Array(ExtractedTaskSchema),
    }),
    async execute(_toolCallId, params, _signal) {
      const typed = params as { tasks: ExtractedTask[] };
      for (const [index, task] of typed.tasks.entries()) {
        const validation = validateBranchInvariants(task);
        if (!validation.valid) {
          throw new Error(`Task ${index} is invalid: ${validation.errors.join("; ")}`);
        }
      }
      capture.tasks = typed.tasks;
      capture.submissionCount += 1;
      return {
        content: [{ type: "text" as const, text: `Accepted ${typed.tasks.length} tasks.` }],
        details: { accepted: typed.tasks.length },
        terminate: true,
      };
    },
  };
}

export interface CalendarToolOptions {
  /** Reads calendar/events.json; returns raw JSON text. */
  readCalendarFile: () => Promise<string>;
}

/**
 * The only filesystem tool available to the email agent. Reads the local
 * calendar dataset, returns conflicts plus up to five free candidate windows,
 * and never writes.
 */
export function createCalendarTool(opts: CalendarToolOptions): AgentTool {
  return {
    name: CALENDAR_TOOL_NAME,
    label: "Find calendar events",
    description:
      "Find busy events and free meeting windows in the local calendar between two instants. Returns existing conflicts and up to five candidate free windows.",
    parameters: Type.Object({
      earliest: Type.String(),
      latest: Type.String(),
      durationMinutes: Type.Number(),
      timezone: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal) {
      const typed = params as {
        earliest: string;
        latest: string;
        durationMinutes: number;
        timezone?: string;
      };
      const raw = await opts.readCalendarFile();
      const calendar = JSON.parse(raw) as CalendarEvents;
      const result = findFreeWindows(
        calendar,
        typed.earliest,
        typed.latest,
        typed.durationMinutes,
        typed.timezone
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}

export function calendarToolFromWorkspace(calendarFilePath: string): AgentTool {
  return createCalendarTool({
    readCalendarFile: async () => readFile(calendarFilePath, "utf8"),
  });
}

export type { CalendarEvents };
