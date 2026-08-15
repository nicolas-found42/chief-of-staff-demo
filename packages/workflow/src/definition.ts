import {
  WORKFLOW_DEFINITION_HASH_PATH,
  WORKFLOW_DEFINITION_PATH,
  WORKFLOW_REVISION,
  WORKFLOW_SCHEMA_VERSION,
} from "@chief-of-staff/contracts";
import { WorkflowError } from "./errors.js";
import { sha256Hex } from "./filesystem.js";

export interface WorkflowInputDef {
  input: string;
  type?: string;
  value?: unknown;
}

export interface WorkflowPathRuleNode {
  or?: WorkflowPathRuleNode[];
  and?: WorkflowPathRuleNode[];
  subject?: { ref: string };
  operator?: string;
  value?: string[];
}

export interface WorkflowPathBranch {
  threadId: string;
  rules: WorkflowPathRuleNode | null;
  fallback: boolean;
}

export interface WorkflowStepDef {
  stepId: string;
  stepType: string;
  title?: string;
  adapter?: string;
  inputs: WorkflowInputDef[];
  userSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  paths?: WorkflowPathBranch[];
  validationErrors?: string[];
  scope?: unknown;
  threadId?: string;
}

export interface WorkflowThreadDef {
  threadId: string;
  parameterId?: string;
  steps: WorkflowStepDef[];
}

export interface WorkflowDefinition {
  schemaVersion: 1;
  revision: number;
  name: string;
  threads: WorkflowThreadDef[];
}

/** Expected topology for revision 219, section 5.2 of the specification. */
export const EXPECTED_THREADS: ReadonlyArray<{
  threadId: string;
  parameterId?: string;
  stepIds: readonly string[];
}> = [
  { threadId: "main", stepIds: ["trigger", "eitxht", "yk5itn", "aase0r"] },
  { threadId: "yk5itn_each", parameterId: "yk5itn_each", stepIds: ["ou028y"] },
  { threadId: "ou028y_xg63bi", parameterId: "ou028y_xg63bi", stepIds: ["maoa1p", "axgv0j", "x1gstq", "7b5596"] },
  { threadId: "ou028y_vd3vc1", parameterId: "ou028y_vd3vc1", stepIds: ["ia2vvr", "kjlw70", "4a71s7", "1730yy"] },
  { threadId: "ou028y_wtnzhv", parameterId: "ou028y_wtnzhv", stepIds: ["8w9czb", "pthrsh"] },
];

export const EXPECTED_STEP_IDS: readonly string[] = EXPECTED_THREADS.flatMap(
  (thread) => thread.stepIds
);

export const DATA_TABLE_STEP_IDS = ["7b5596", "1730yy", "pthrsh"] as const;

export function getThread(
  definition: WorkflowDefinition,
  threadId: string
): WorkflowThreadDef {
  const thread = definition.threads.find((t) => t.threadId === threadId);
  if (!thread) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_CHANGED",
      `Workflow thread not found: ${threadId}`
    );
  }
  return thread;
}

export function getStep(
  definition: WorkflowDefinition,
  stepId: string
): WorkflowStepDef {
  for (const thread of definition.threads) {
    const step = thread.steps.find((s) => s.stepId === stepId);
    if (step) {
      return step;
    }
  }
  throw new WorkflowError(
    "WORKFLOW_DEFINITION_CHANGED",
    `Workflow step not found: ${stepId}`
  );
}

export function getMainThread(definition: WorkflowDefinition): WorkflowThreadDef {
  return getThread(definition, "main");
}



/** Step types executed by the interpreter itself rather than an adapter. */
export const ENGINE_STEP_TYPES = [
  "ai.prompt.object",
  "ai.prompt.text",
  "iterator",
  "paths",
] as const;

export function isEngineStepType(stepType: string): boolean {
  return (ENGINE_STEP_TYPES as readonly string[]).includes(stepType);
}

export function getIteratorTargetThread(
  definition: WorkflowDefinition,
  iteratorStep: WorkflowStepDef
): WorkflowThreadDef {
  const threadId = iteratorStep.threadId;
  if (!threadId) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_CHANGED",
      `Iterator step ${iteratorStep.stepId} has no target thread`
    );
  }
  return getThread(definition, threadId);
}

export function getIteratorParameterSchema(
  definition: WorkflowDefinition
): { properties: Record<string, unknown>; required: string[] } {
  const extraction = getStep(definition, "eitxht");
  const userSchema = extraction.userSchema as
    | { items?: { properties?: Record<string, unknown>; required?: string[] } }
    | undefined;
  const items = userSchema?.items;
  if (!items || typeof items.properties !== "object" || items.properties === null) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_CHANGED",
      "Extraction userSchema is missing its item properties"
    );
  }
  return {
    properties: items.properties,
    required: Array.isArray(items.required) ? (items.required as string[]) : [],
  };
}

/** Extracts every reference path used by a step's input values. */
export function collectStepReferences(step: WorkflowStepDef): string[] {
  const refs = new Set<string>();
  const scanInline = (value: string, loopVar: string | null): void => {
    for (const match of value.matchAll(/\{\{([A-Za-z0-9_. ]+?)\}\}/g)) {
      const ref = match[1].trim();
      if (loopVar !== null && (ref === loopVar || ref.startsWith(`${loopVar}.`))) {
        continue;
      }
      refs.add(ref);
    }
  };
  const scanValue = (value: unknown): void => {
    if (typeof value === "string") {
      const eachRegex = /\{\{#each\s+(\w+)\s+in\s+([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
      let cursor = 0;
      for (const match of value.matchAll(eachRegex)) {
        const index = match.index ?? 0;
        scanInline(value.slice(cursor, index), null);
        refs.add(`#each:${match[1]}:${match[2]}`);
        scanInline(match[3], match[1]);
        cursor = index + match[0].length;
      }
      scanInline(value.slice(cursor), null);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        scanValue(item);
      }
    } else if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      if (typeof record.ref === "string" && Object.keys(record).length === 1) {
        refs.add(record.ref);
        return;
      }
      for (const nested of Object.values(record)) {
        scanValue(nested);
      }
    }
  };
  const scanRuleNode = (node: WorkflowPathRuleNode): void => {
    if (typeof node.subject?.ref === "string") {
      refs.add(node.subject.ref);
      return;
    }
    for (const child of [...(node.or ?? []), ...(node.and ?? [])]) {
      scanRuleNode(child);
    }
  };
  for (const input of step.inputs ?? []) {
    scanValue(input.value);
  }
  for (const branch of step.paths ?? []) {
    if (branch.rules) {
      scanRuleNode(branch.rules);
    }
  }
  return [...refs];
}

const KNOWN_SYSTEM_REFS = new Set(["system.now"]);
const TRIGGER_FIELDS = new Set(["Title", "File URL", "Creation time"]);

function refFieldSchema(step: WorkflowStepDef | undefined, field: string): boolean {
  if (!step?.outputSchema) {
    return false;
  }
  const schema = step.outputSchema as {
    properties?: Record<string, unknown>;
    type?: string;
  };
  if (schema.type === "array") {
    return false;
  }
  return typeof schema.properties?.[field] === "object";
}

/** Validates that every reference in the definition points at a declared
 * output. Returns a list of violations (empty when valid). */
export function validateReferenceSyntax(definition: WorkflowDefinition): string[] {
  const violations: string[] = [];
  const stepsById = new Map<string, WorkflowStepDef>();
  for (const thread of definition.threads) {
    for (const step of thread.steps) {
      stepsById.set(step.stepId, step);
    }
  }
  const iteratorSchema = getIteratorParameterSchema(definition);
  const knownStepIds = new Set(stepsById.keys());

  for (const step of [...stepsById.values()]) {
    for (const ref of collectStepReferences(step)) {
      if (ref.startsWith("#each:")) {
        const [, _loopVar, source] = ref.split(":");
        if (source !== "eitxht") {
          violations.push(
            `Step ${step.stepId}: loop source "${source}" is not a declared collection output`
          );
        }
        continue;
      }
      if (KNOWN_SYSTEM_REFS.has(ref)) {
        continue;
      }
      const [root, field] = ref.split(".");
      if (root === "trigger") {
        if (!field || !TRIGGER_FIELDS.has(field)) {
          violations.push(
            `Step ${step.stepId}: reference "${ref}" is not a declared trigger output field`
          );
        }
        continue;
      }
      if (root === "eitxht" && !field) {
        continue;
      }
      if (root === "yk5itn_each") {
        if (!field || !(field in iteratorSchema.properties)) {
          violations.push(
            `Step ${step.stepId}: reference "${ref}" is not a declared iterator parameter field`
          );
        }
        continue;
      }
      if (knownStepIds.has(root)) {
        const target = stepsById.get(root);
        if (!field || !refFieldSchema(target, field)) {
          violations.push(
            `Step ${step.stepId}: reference "${ref}" is not a declared output of step ${root}`
          );
        }
        continue;
      }
      violations.push(`Step ${step.stepId}: reference "${ref}" has an unknown root`);
    }
  }
  return violations;
}

export interface DefinitionValidationResult {
  valid: boolean;
  violations: string[];
}

/**
 * Full startup validation per section 5 of the specification:
 * schema version, revision, topology, hash, adapter registration, reference
 * syntax, and the three known data-table validation errors.
 */
export function validateDefinition(
  definition: WorkflowDefinition,
  expectedSha256: string,
  actualSha256: string,
  registeredStepTypes: ReadonlySet<string>
): DefinitionValidationResult {
  const violations: string[] = [];
  if (definition.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    violations.push(`schemaVersion must be ${WORKFLOW_SCHEMA_VERSION}`);
  }
  if (definition.revision !== WORKFLOW_REVISION) {
    violations.push(`revision must be ${WORKFLOW_REVISION}`);
  }
  if (actualSha256 !== expectedSha256) {
    violations.push("workflow definition SHA-256 does not match the stored hash");
  }
  const expectedThreadIds = EXPECTED_THREADS.map((t) => t.threadId);
  const actualThreadIds = definition.threads.map((t) => t.threadId);
  if (JSON.stringify(actualThreadIds) !== JSON.stringify(expectedThreadIds)) {
    violations.push(
      `thread IDs must be ${expectedThreadIds.join(", ")} in order, got ${actualThreadIds.join(", ")}`
    );
  }
  for (const expected of EXPECTED_THREADS) {
    const thread = definition.threads.find((t) => t.threadId === expected.threadId);
    if (!thread) {
      continue;
    }
    const actual = thread.steps.map((s) => s.stepId);
    if (JSON.stringify(actual) !== JSON.stringify(expected.stepIds)) {
      violations.push(
        `thread ${expected.threadId} steps must be ${expected.stepIds.join(", ")} in order, got ${actual.join(", ")}`
      );
    }
    if (expected.parameterId && thread.parameterId !== expected.parameterId) {
      violations.push(
        `thread ${expected.threadId} must have parameterId ${expected.parameterId}`
      );
    }
  }
  for (const step of definition.threads.flatMap((t) => t.steps)) {
    if (!step.adapter && !isEngineStepType(step.stepType)) {
      violations.push(`step ${step.stepId} has no adapter`);
      continue;
    }
    if (!registeredStepTypes.has(step.stepType) && !isEngineStepType(step.stepType)) {
      violations.push(`step ${step.stepId} references unregistered step type ${step.stepType}`);
    }
  }
  for (const stepId of DATA_TABLE_STEP_IDS) {
    const step = stepsById(definition).get(stepId);
    if (!step || !step.validationErrors?.includes("Scope is not set")) {
      violations.push(`step ${stepId} is missing the known "Scope is not set" validation error`);
    }
  }
  try {
    violations.push(...validateReferenceSyntax(definition));
  } catch (error) {
    violations.push(
      `reference validation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return { valid: violations.length === 0, violations };
}

function stepsById(definition: WorkflowDefinition): Map<string, WorkflowStepDef> {
  const map = new Map<string, WorkflowStepDef>();
  for (const thread of definition.threads) {
    for (const step of thread.steps) {
      map.set(step.stepId, step);
    }
  }
  return map;
}

export interface LoadedDefinition {
  definition: WorkflowDefinition;
  sha256: string;
}

export interface DefinitionPaths {
  definitionPath: string;
  hashPath: string;
  repoRoot: string;
}

export function defaultDefinitionPaths(repoRoot: string): DefinitionPaths {
  return {
    definitionPath: `${repoRoot}/${WORKFLOW_DEFINITION_PATH}`,
    hashPath: `${repoRoot}/${WORKFLOW_DEFINITION_HASH_PATH}`,
    repoRoot,
  };
}

/** Load, hash-check, and validate the canonical definition. Fails closed with
 * WORKFLOW_DEFINITION_CHANGED on any mismatch. */
export async function loadAndValidateDefinition(
  paths: DefinitionPaths,
  registeredStepTypes: ReadonlySet<string>,
  readFile: (path: string) => Promise<string>
): Promise<LoadedDefinition> {
  let definitionText: string;
  let expectedSha256: string;
  try {
    [definitionText, expectedSha256] = await Promise.all([
      readFile(paths.definitionPath),
      readFile(paths.hashPath),
    ]);
  } catch (error) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_CHANGED",
      `Unable to read the workflow definition or its stored hash: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
  const actualSha256 = sha256Hex(definitionText);
  let definition: WorkflowDefinition;
  try {
    definition = JSON.parse(definitionText) as WorkflowDefinition;
  } catch (error) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_CHANGED",
      `The workflow definition is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
  const result = validateDefinition(
    definition,
    expectedSha256.trim(),
    actualSha256,
    registeredStepTypes
  );
  if (!result.valid) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_CHANGED",
      `The committed workflow definition no longer matches the specification. Review the new ` +
        `export and update the specification, tests, and stored hash. Violations:\n- ${result.violations.join(
          "\n- "
        )}`
    );
  }
  return { definition, sha256: actualSha256 };
}
