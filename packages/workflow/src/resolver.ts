import { WorkflowError } from "./errors.js";
import { renderTemplate } from "./templates.js";

export interface ResolverContext {
  /** The current iterator object, exposed as the `yk5itn_each` namespace. */
  iterator?: Record<string, unknown> | null;
  /** Completed step outputs in the current scope, keyed by step id. */
  artifacts?: Map<string, unknown>;
  /** Trigger output. */
  trigger?: Record<string, unknown>;
  /** System context. */
  system?: { now: string };
  /** Accepted tasks (post assignment filter), the `eitxht` collection. */
  eitxht?: unknown[];
}

export interface IteratorSchema {
  properties: Record<string, unknown>;
  required: string[];
}

function readPath(record: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, key) => {
      if (acc === null || acc === undefined || typeof acc !== "object") {
        return undefined;
      }
      return (acc as Record<string, unknown>)[key];
    }, record);
}

/**
 * Resolves object refs, inline refs, system refs, and iterator references.
 * Resolution order is the current iterator context, completed invocation
 * artifacts, the trigger artifact, then system context.
 */
export class ReferenceResolver {
  constructor(private readonly iteratorSchema: IteratorSchema) {}

  private describe(ref: string, consumingStepId: string): string {
    return `Unresolved reference "${ref}" in step ${consumingStepId}`;
  }

  /** Resolve a dotted reference to its value. Missing optional properties
   * resolve to null; missing required values throw UNRESOLVED_REFERENCE. */
  resolveRef(ref: string, ctx: ResolverContext, consumingStepId: string): unknown {
    const [root, ...rest] = ref.split(".");
    const field = rest.join(".");

    if (root === "system") {
      if (field === "now" && ctx.system) {
        return ctx.system.now;
      }
      throw new WorkflowError("UNRESOLVED_REFERENCE", this.describe(ref, consumingStepId));
    }

    if (root === "eitxht" && field === "") {
      if (!Array.isArray(ctx.eitxht)) {
        throw new WorkflowError("UNRESOLVED_REFERENCE", this.describe(ref, consumingStepId));
      }
      return ctx.eitxht;
    }

    if (root === "yk5itn_each") {
      const value =
        ctx.iterator === undefined || ctx.iterator === null
          ? undefined
          : readPath(ctx.iterator, field);
      if (value === undefined || value === null) {
        if (field !== "" && !(field in this.iteratorSchema.properties)) {
          throw new WorkflowError(
            "WORKFLOW_DEFINITION_CHANGED",
            `Reference "${ref}" is not a declared iterator parameter field`
          );
        }
        const isRequired = field === "" || this.iteratorSchema.required.includes(field);
        if (isRequired) {
          throw new WorkflowError("UNRESOLVED_REFERENCE", this.describe(ref, consumingStepId));
        }
        return null;
      }
      return value;
    }


    if (root === "trigger") {
      const value = ctx.trigger === undefined ? undefined : ctx.trigger[field];
      if (value === undefined || value === null || value === "") {
        throw new WorkflowError("UNRESOLVED_REFERENCE", this.describe(ref, consumingStepId));
      }
      return value;
    }

    const artifact = ctx.artifacts?.get(root);
    if (artifact !== undefined) {
      const record = artifact as Record<string, unknown>;
      const value = field === "" ? record : record[field];
      if (value === undefined || value === null) {
        throw new WorkflowError("UNRESOLVED_REFERENCE", this.describe(ref, consumingStepId));
      }
      return value;
    }

    throw new WorkflowError("UNRESOLVED_REFERENCE", this.describe(ref, consumingStepId));
  }
  /** Render a template string; missing optional values become empty strings.
   * Collection refs (each-block sources) stay raw arrays. */
  render(template: string, ctx: ResolverContext, consumingStepId: string): string {
    return renderTemplate(template, (ref) => {
      const value = this.resolveRef(ref, ctx, consumingStepId);
      if (value === null || value === undefined) {
        return "";
      }
      return value;
    });
  }

  /** Resolve an input value of any exported shape: literal, string template,
   * object ref, or array of those. */
  resolveInputValue(
    value: unknown,
    ctx: ResolverContext,
    consumingStepId: string
  ): unknown {
    if (typeof value === "string") {
      return this.render(value, ctx, consumingStepId);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.resolveInputValue(item, ctx, consumingStepId));
    }
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      if (typeof record.ref === "string" && Object.keys(record).length === 1) {
        return this.resolveRef(record.ref, ctx, consumingStepId);
      }
      const resolved: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(record)) {
        resolved[key] = this.resolveInputValue(nested, ctx, consumingStepId);
      }
      return resolved;
    }
    return value;
  }

  /** Resolve all inputs of a step into a plain record keyed by input name. */
  resolveInputs(
    inputs: ReadonlyArray<{ input: string; value?: unknown }>,
    ctx: ResolverContext,
    consumingStepId: string
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const input of inputs) {
      resolved[input.input] = this.resolveInputValue(input.value, ctx, consumingStepId);
    }
    return resolved;
  }
}
