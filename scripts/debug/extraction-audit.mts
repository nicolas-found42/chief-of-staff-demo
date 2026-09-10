/** Retained-output diagnostic: semantic sentinels, not a complete quality score. */
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import {
  buildDebriefMessages,
  normalizeDebriefExtraction,
} from "../../apps/server/src/modules/meeting-debrief/extraction.js";
import { join } from "node:path";
import type { MeetingDebriefExtraction, TranscriptRecord } from "@chief-of-staff-demo/shared";

if (process.argv[2] === "--replay-dir") {
  const [input, output] = process.argv.slice(3);
  if (!input || !output) throw new Error("--replay-dir input output (new directory)");
  await mkdir(output, { recursive: false });
  for (const file of (await readdir(input)).filter((name) => name.endsWith(".debrief.json"))) {
    const capture = JSON.parse(await readFile(join(input, file), "utf8")) as {
      modelRaw?: unknown;
      raw?: MeetingDebriefExtraction;
      model?: string;
    };
    const sourceName = file.replace(/\.debrief\.json$/, "");
    const record = {
      normalizedText: await readFile(
        join("tests/fixtures/debrief-golden/transcripts", sourceName),
        "utf8",
      ),
      meetingDate: sourceName.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
      roster: [],
      occurrence: null,
    } as unknown as TranscriptRecord;
    const request = buildDebriefMessages(record, {
      mentions: [],
      decisions: [],
      organizations: [],
    });
    const checked = request.schema.safeParse(capture.modelRaw);
    const raw = checked.success
      ? normalizeDebriefExtraction(checked.data, record)
      : capture.modelRaw;
    await writeFile(
      join(output, file),
      JSON.stringify({ ...capture, valid: checked.success, raw, replay: true }, null, 2),
    );
  }
  console.log(
    "Replayed retained output through current validation and normalization; no model calls.",
  );
  process.exit(0);
}

const transcript = await readFile(
  "tests/fixtures/operational-handoff/2026-09-09-found42-stand-up.md",
  "utf8",
);
const record = {
  normalizedText: transcript,
  meetingDate: "2026-09-09",
  roster: [],
  occurrence: null,
} as unknown as TranscriptRecord;
const path =
  process.argv[2] ??
  "docs/research/operational-handoff-evaluation-2026-09-09/candidate-representative.json";
const capture = JSON.parse(await readFile(path, "utf8")) as { modelRaw?: unknown };
const messages = buildDebriefMessages(record, { mentions: [], decisions: [], organizations: [] });
const parsed = messages.schema.safeParse(capture.modelRaw);
if (!parsed.success) {
  console.log(JSON.stringify({ stage: "shape", issues: parsed.error.issues }, null, 2));
  process.exit(1);
}
const normalized = normalizeDebriefExtraction(parsed.data, record);
let failures = 0;
for (const [stage, extraction] of [
  ["model", parsed.data],
  ["normalized", normalized],
] as const) {
  const items = extraction.actionItems;
  const checks = {
    missingCourseCommitment: !items.some(
      (a) => /course/i.test(a.title) && /structur|think|build/i.test(a.title),
    ),
    missingReferenceFollowup: !items.some((a) => /reference|testimonial/i.test(a.title)),
    falsePendingWalkthrough: items.some((a) => /walkthrough of project structure/i.test(a.title)),
    unsupportedFolderTiming: items.some((a) => /folder/i.test(a.title) && a.dueDate !== null),
    responsibility: "manual semantic review required",
    evidenceQuotes: items.reduce((n, a) => n + (a.handoff?.evidence.length ?? 0), 0),
    quoteEntailment:
      "manual semantic review required; normalization checks source text presence only",
  };
  failures += Object.values(checks).filter((v) => v === true).length;
  console.log(JSON.stringify({ stage, actions: items.length, checks }, null, 2));
}
process.exitCode = failures ? 1 : 0;
