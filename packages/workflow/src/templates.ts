import { WorkflowError } from "./errors.js";

export type TemplateLookup = (ref: string) => unknown;

interface EachBlock {
  start: number;
  headerEnd: number;
  end: number;
  loopVar: string;
  source: string;
  bodyStart: number;
  bodyEnd: number;
}

function findEachBlock(template: string, from: number): EachBlock | null {
  const startMatch = /\{\{#each\s+(\w+)\s+in\s+([\w.]+)\}\}/g;
  startMatch.lastIndex = from;
  const start = startMatch.exec(template);
  if (!start) {
    return null;
  }
  const headerEnd = startMatch.lastIndex;
  const end = template.indexOf("{{/each}}", headerEnd);
  if (end < 0) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_CHANGED",
      `Template contains an unclosed {{#each}} block: ${template.slice(start.index, start.index + 80)}`
    );
  }
  return {
    start: start.index,
    headerEnd,
    end,
    loopVar: start[1],
    source: start[2],
    bodyStart: headerEnd,
    bodyEnd: end,
  };
}

function renderInline(template: string, lookup: TemplateLookup): string {
  return template.replace(/\{\{([A-Za-z0-9_. ]+?)\}\}/g, (_match, ref: string) => {
    const value = lookup(ref.trim());
    if (value === null || value === undefined) {
      return "";
    }
    return String(value);
  });
}

/**
 * Render a template with `{{ref}}` inline references and `{{#each x in y}}`
 * blocks. Missing optional values render as empty strings; the resolver
 * decides what counts as missing-required and throws UNRESOLVED_REFERENCE.
 */
export function renderTemplate(template: string, lookup: TemplateLookup): string {
  let result = "";
  let cursor = 0;
  for (;;) {
    const block = findEachBlock(template, cursor);
    if (!block) {
      result += renderInline(template.slice(cursor), lookup);
      break;
    }
    result += renderInline(template.slice(cursor, block.start), lookup);
    const collection = lookup(block.source);
    if (collection === null || collection === undefined) {
      result += "";
    } else if (Array.isArray(collection)) {
      const body = template.slice(block.bodyStart, block.bodyEnd);
      for (const item of collection) {
        result += renderInline(body, (ref) => {
          if (ref === block.loopVar) {
            return item;
          }
          if (ref.startsWith(`${block.loopVar}.`)) {
            const path = ref.slice(block.loopVar.length + 1);
            const record = (item ?? {}) as Record<string, unknown>;
            return path.split(".").reduce<unknown>((acc, key) => {
              if (acc === null || acc === undefined || typeof acc !== "object") {
                return undefined;
              }
              return (acc as Record<string, unknown>)[key];
            }, record);
          }
          return lookup(ref);
        });
      }
    } else {
      throw new WorkflowError(
        "WORKFLOW_DEFINITION_CHANGED",
        `Template loop source "${block.source}" is not an array`
      );
    }
    cursor = block.end + "{{/each}}".length;
  }
  return result;
}

/** Extract the loop sources used by a template (for validation). */
export function collectTemplateLoopSources(template: string): string[] {
  const sources: string[] = [];
  for (const match of template.matchAll(/\{\{#each\s+\w+\s+in\s+([\w.]+)\}\}/g)) {
    sources.push(match[1]);
  }
  return sources;
}
