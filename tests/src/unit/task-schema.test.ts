import { describe, expect, it } from "vitest";
import {
  ExtractedTaskSchema,
  Type,
  validateBranchInvariants,
  type ExtractedTask,
} from "@chief-of-staff/contracts";
import { Value } from "typebox/value";

const validEmail: ExtractedTask = {
  "Task name": "Email supplier about delivery timeline",
  "Task type": "email",
  "Assigned to": "Ada Lovelace",
  Deadline: "2026-08-15T15:00:00.000Z",
  "Email details": {
    Recipient: "supplier@example.com",
    Subject: "Delivery timeline update",
    Body: "Body",
  },
};

describe("extracted task schema", () => {
  it("accepts a valid email task", () => {
    expect(validateBranchInvariants(validEmail).valid).toBe(true);
    expect([...Value.Errors(ExtractedTaskSchema, validEmail)]).toEqual([]);
  });

  it("rejects an email task without complete Email details", () => {
    const result = validateBranchInvariants({
      ...validEmail,
      "Email details": { Recipient: "x", Subject: "" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join("; ")).toMatch(/complete Email details/);
  });

  it("rejects a business plan without complete Business plan details", () => {
    const result = validateBranchInvariants({
      "Task name": "Plan",
      "Task type": "business plan",
      "Assigned to": "Ada Lovelace",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join("; ")).toMatch(/complete Business plan details/);
  });

  it("rejects an other task without a Task description", () => {
    const result = validateBranchInvariants({
      "Task name": "Chore",
      "Task type": "other",
      "Assigned to": "Ada Lovelace",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join("; ")).toMatch(/Task description/);
  });

  it("rejects names longer than 50 code points and empty names", () => {
    const longName = "x".repeat(51);
    expect(validateBranchInvariants({ ...validEmail, "Task name": longName }).valid).toBe(false);
    expect(validateBranchInvariants({ ...validEmail, "Task name": "  " }).valid).toBe(false);
    expect(validateBranchInvariants({ ...validEmail, "Task name": "x".repeat(50) }).valid).toBe(true);
  });

  it("rejects a Deadline that is not an ISO 8601 date-time", () => {
    const result = validateBranchInvariants({ ...validEmail, Deadline: "tomorrow" });
    expect(result.valid).toBe(false);
    expect(result.errors.join("; ")).toMatch(/ISO 8601/);
  });

  it("accepts an absent Deadline", () => {
    expect(validateBranchInvariants({ ...validEmail, Deadline: undefined }).valid).toBe(true);
  });

  it("keeps the three exported task types only", () => {
    const schema = ExtractedTaskSchema.properties["Task type"] as { anyOf?: Array<{ const?: string }> };
    const constants = (schema.anyOf ?? []).map((option) => option.const).sort();
    expect(constants).toEqual(["business plan", "email", "other"]);
    const invalid = { ...validEmail, "Task type": "meeting" as never };
    expect([...Value.Errors(ExtractedTaskSchema, invalid)].length).toBeGreaterThan(0);
  });

  it("derives the runtime schema from the export's userSchema shape", () => {
    const required = ExtractedTaskSchema.required;
    expect(required).toContain("Task name");
    expect(required).toContain("Task type");
    expect(required).toContain("Assigned to");
    expect(required).not.toContain("Deadline");
    expect(required).not.toContain("Email details");
  });

  it("compiles the TypeBox schema used by the extraction tool", () => {
    const compiled = Value.Create(Type.Object({ tasks: Type.Array(ExtractedTaskSchema) }));
    expect(compiled).toEqual({ tasks: [] });
  });
});
