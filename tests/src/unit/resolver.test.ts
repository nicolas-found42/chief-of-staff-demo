import { describe, expect, it } from "vitest";
import {
  getIteratorParameterSchema,
  ReferenceResolver,
  renderTemplate,
  type ResolverContext,
} from "@chief-of-staff/workflow";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REFERENCE_DIR } from "../helpers/engine.js";
import type { WorkflowDefinition } from "@chief-of-staff/workflow";

function definition(): WorkflowDefinition {
  return JSON.parse(
    readFileSync(join(REFERENCE_DIR, "workflow-definition.json"), "utf8")
  ) as WorkflowDefinition;
}

function resolver(): ReferenceResolver {
  return new ReferenceResolver(getIteratorParameterSchema(definition()));
}

const trigger = {
  Title: "golden-meeting",
  "File URL": "local://source/processing/run-1/golden-meeting.txt",
  "Creation time": "2026-08-15T15:00:00.000Z",
};

const task = {
  "Task name": "Email supplier about delivery timeline",
  "Task type": "email",
  "Assigned to": "Ada Lovelace",
  Deadline: "2026-08-15T15:00:00.000Z",
  "Email details": {
    Recipient: "supplier@example.com",
    Subject: "Delivery timeline update",
    Body: "Body text",
  },
};

function ctx(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    iterator: task,
    artifacts: new Map<string, unknown>([
      ["maoa1p", { message: "drafted email body" }],
      ["axgv0j", { "Draft URL": "local://gmail/drafts/abc.md" }],
    ]),
    trigger,
    system: { now: "2026-08-15T15:00:00.000Z" },
    eitxht: [task],
    ...overrides,
  };
}

describe("reference resolver", () => {
  it("resolves system refs from the run's injected clock", () => {
    const value = resolver().resolveRef("system.now", ctx(), "eitxht");
    expect(value).toBe("2026-08-15T15:00:00.000Z");
  });

  it("resolves object refs inside the iterator namespace", () => {
    const value = resolver().resolveRef("yk5itn_each.Email details.Recipient", ctx(), "axgv0j");
    expect(value).toBe("supplier@example.com");
  });

  it("resolves completed invocation artifacts", () => {
    const value = resolver().resolveRef("maoa1p.message", ctx(), "axgv0j");
    expect(value).toBe("drafted email body");
  });

  it("resolves trigger fields", () => {
    expect(resolver().resolveRef("trigger.Title", ctx(), "aase0r")).toBe("golden-meeting");
    expect(resolver().resolveRef("trigger.File URL", ctx(), "aase0r")).toContain("local://");
  });

  it("resolves an optional missing iterator property to null", () => {
    const withoutDeadline = ctx({ iterator: { ...task, Deadline: undefined } });
    const value = resolver().resolveRef("yk5itn_each.Deadline", withoutDeadline, "x1gstq");
    expect(value).toBeNull();
  });

  it("renders optional missing properties as empty strings inline", () => {
    const withoutDeadline = ctx({ iterator: { ...task, Deadline: undefined } });
    const rendered = resolver().render("due={{yk5itn_each.Deadline}}", withoutDeadline, "x1gstq");
    expect(rendered).toBe("due=");
  });

  it("throws UNRESOLVED_REFERENCE with the full reference and consuming step", () => {
    const missing = ctx({ trigger: undefined, artifacts: new Map(), system: undefined });
    const attempt = () => resolver().resolveRef("trigger.Title", missing, "aase0r");
    expect(attempt).toThrow(/Unresolved reference "trigger\.Title" in step aase0r/);
  });

  it("throws UNRESOLVED_REFERENCE for a missing required iterator field", () => {
    const broken = ctx({ iterator: { "Task type": "email" } });
    const attempt = () => resolver().resolveRef("yk5itn_each.Task name", broken, "x1gstq");
    expect(attempt).toThrow(/Unresolved reference "yk5itn_each\.Task name"/);
  });

  it("resolves input values of all exported shapes", () => {
    const r = resolver();
    const inputs = [
      { input: "literal", value: "fixed" },
      { input: "template", value: "Subject: {{yk5itn_each.Email details.Subject}}" },
      { input: "ref", value: { ref: "yk5itn_each.Email details.Recipient" } },
      { input: "array", value: [{ ref: "yk5itn_each.Email details.Recipient" }, "Inbox"] },
    ];
    const resolved = r.resolveInputs(inputs, ctx(), "axgv0j");
    expect(resolved).toEqual({
      literal: "fixed",
      template: "Subject: Delivery timeline update",
      ref: "supplier@example.com",
      array: ["supplier@example.com", "Inbox"],
    });
  });
});

describe("template rendering", () => {
  it("renders each blocks over the eitxht collection in order", () => {
    const body = "Tasks extracted:\n{{#each task in eitxht}}\n- {{task.Task name}} ({{task.Task type}})\n{{/each}}";
    const rendered = renderTemplate(body, (ref) => (ref === "eitxht" ? ctx().eitxht : undefined));
    expect(rendered).toBe(
      "Tasks extracted:\n\n- Email supplier about delivery timeline (email)\n"
    );
  });

  it("keeps the exported notification template byte-stable", () => {
    const def = definition();
    const aase0r = def.threads.flatMap((t) => t.steps).find((s) => s.stepId === "aase0r")!;
    const subject = aase0r.inputs.find((i) => i.input === "subject")!.value as string;
    expect(subject).toBe("Transcription Processed - {{trigger.Title}}");
    const body = aase0r.inputs.find((i) => i.input === "body")!.value as string;
    expect(body).toContain("The following transcription has been processed:");
    expect(body).toContain("Tasks extracted:");
    expect(body).toContain("{{#each task in eitxht}}");
  });

  it("throws on an unclosed each block", () => {
    expect(() => renderTemplate("{{#each task in eitxht}}oops", () => undefined)).toThrow(
      /unclosed/
    );
  });
});
