import { describe, expect, it } from "vitest";
import {
  ENGINE_STEP_TYPES,
  EXPECTED_STEP_IDS,
  EXPECTED_THREADS,
  loadAndValidateDefinition,
  validateDefinition,
  validateReferenceSyntax,
  type WorkflowDefinition,
  WorkflowError,
} from "@chief-of-staff/workflow";
import { buildAdapterRegistry } from "@chief-of-staff/workflow";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REFERENCE_DIR, REPO_ROOT } from "../helpers/engine.js";

const registeredStepTypes = new Set<string>([
  ...buildAdapterRegistry().keys(),
  ...ENGINE_STEP_TYPES,
]);

function loadDefinition(): WorkflowDefinition {
  return JSON.parse(
    readFileSync(join(REFERENCE_DIR, "workflow-definition.json"), "utf8")
  ) as WorkflowDefinition;
}

describe("workflow definition validation", () => {
  it("loads and validates the frozen definition against its stored hash", async () => {
    const result = await loadAndValidateDefinition(
      {
        definitionPath: join(REFERENCE_DIR, "workflow-definition.json"),
        hashPath: join(REFERENCE_DIR, "workflow-definition.sha256"),
        repoRoot: REPO_ROOT,
      },
      registeredStepTypes,
      (path) => Promise.resolve(readFileSync(path, "utf8"))
    );
    expect(result.definition.schemaVersion).toBe(1);
    expect(result.definition.revision).toBe(219);
    expect(result.definition.threads.map((t) => t.threadId)).toEqual(
      EXPECTED_THREADS.map((t) => t.threadId)
    );
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("preserves the 15 exported step identities and their order", () => {
    const definition = loadDefinition();
    const stepIds = definition.threads.flatMap((t) => t.steps.map((s) => s.stepId));
    expect(stepIds).toEqual(EXPECTED_STEP_IDS);
    expect(stepIds).toHaveLength(15);
    for (const expected of EXPECTED_THREADS) {
      const thread = definition.threads.find((t) => t.threadId === expected.threadId);
      expect(thread?.steps.map((s) => s.stepId)).toEqual(expected.stepIds);
    }
  });

  it("sets every AI step model input to the configured OpenRouter model", () => {
    const definition = loadDefinition();
    for (const step of definition.threads.flatMap((t) => t.steps)) {
      if (step.stepType === "ai.prompt.object" || step.stepType === "ai.prompt.text") {
        const modelInput = step.inputs.find((i) => i.input === "model");
        expect(modelInput?.value).toBe("nvidia/nemotron-3.5-lightning");
      }
    }
  });

  it("fails closed with WORKFLOW_DEFINITION_CHANGED on a hash mismatch", async () => {
    const definitionText = readFileSync(
      join(REFERENCE_DIR, "workflow-definition.json"),
      "utf8"
    );
    const promise = loadAndValidateDefinition(
      {
        definitionPath: join(REFERENCE_DIR, "workflow-definition.json"),
        hashPath: join(REFERENCE_DIR, "workflow-definition.sha256"),
        repoRoot: REPO_ROOT,
      },
      registeredStepTypes,
      (path) =>
        Promise.resolve(path.endsWith(".sha256") ? "00".repeat(32) : definitionText)
    );
    await expect(promise).rejects.toMatchObject({ code: "WORKFLOW_DEFINITION_CHANGED" });
    await expect(promise).rejects.toThrow(/update the specification, tests, and stored hash/i);
  });

  it("fails on a tampered step identity", () => {
    const definition = loadDefinition();
    definition.threads[0].steps[1].stepId = "tampered";
    const result = validateDefinition(
      definition,
      readFileSync(join(REFERENCE_DIR, "workflow-definition.sha256"), "utf8").trim(),
      "00".repeat(32),
      registeredStepTypes
    );
    expect(result.valid).toBe(false);
    expect(result.violations.join("\n")).toMatch(/main steps must be/);
  });

  it("fails when an adapter step type is not registered", () => {
    const definition = loadDefinition();
    definition.threads[0].steps[0].stepType = "drive.unknownFolderWatcher";
    const result = validateDefinition(
      definition,
      readFileSync(join(REFERENCE_DIR, "workflow-definition.sha256"), "utf8").trim(),
      "00".repeat(32),
      registeredStepTypes
    );
    expect(result.valid).toBe(false);
    expect(result.violations.join("\n")).toMatch(/unregistered step type/);
  });

  it("requires the three known data-table validation errors", () => {
    const definition = loadDefinition();
    const tableStep = definition.threads
      .flatMap((t) => t.steps)
      .find((s) => s.stepId === "7b5596");
    tableStep!.validationErrors = [];
    const result = validateDefinition(
      definition,
      readFileSync(join(REFERENCE_DIR, "workflow-definition.sha256"), "utf8").trim(),
      "00".repeat(32),
      registeredStepTypes
    );
    expect(result.valid).toBe(false);
    expect(result.violations.join("\n")).toMatch(/missing the known "Scope is not set"/);
  });

  it("rejects unknown reference roots at validation time", () => {
    const definition = loadDefinition();
    const step = definition.threads
      .flatMap((t) => t.steps)
      .find((s) => s.stepId === "x1gstq")!;
    step.inputs[0].value = "{{nonexistent.Field}}";
    const violations = validateReferenceSyntax(definition);
    expect(violations.some((v) => v.includes("unknown root"))).toBe(true);
  });

  it("accepts all references used by the frozen definition", () => {
    const definition = loadDefinition();
    expect(validateReferenceSyntax(definition)).toEqual([]);
  });

  it("rejects a tampered hash with an actionable message", async () => {
    const definition = loadDefinition();
    definition.revision = 220;
    const result = validateDefinition(
      definition,
      readFileSync(join(REFERENCE_DIR, "workflow-definition.sha256"), "utf8").trim(),
      "00".repeat(32),
      registeredStepTypes
    );
    expect(result.valid).toBe(false);
    expect(result.violations.join("\n")).toMatch(/revision must be 219/);
  });

  it("throws a WorkflowError carrying the code for downstream handling", async () => {
    const error = new WorkflowError("WORKFLOW_DEFINITION_CHANGED", "x");
    expect(error.code).toBe("WORKFLOW_DEFINITION_CHANGED");
    expect(error.retryable).toBe(false);
  });
});
