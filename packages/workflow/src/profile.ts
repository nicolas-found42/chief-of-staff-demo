import type { ProfileConfig } from "@chief-of-staff/contracts";
import { WorkflowError } from "./errors.js";

const WRITING_STYLE_PLACEHOLDER = /\[DESCRIBE YOUR WRITING STYLE,[^\]]*\]/g;
const FOCUS_AREAS_PLACEHOLDER = /\[LIST YOUR KEY FOCUS AREAS HERE,[^\]]*\]/g;
const NAME_PLACEHOLDER = /\[YOUR NAME\]/g;
const TITLE_PLACEHOLDER = /\[YOUR TITLE\]/g;
const COMPANY_PLACEHOLDER = /\[YOUR COMPANY\]/g;

const LEFTOVER_PLACEHOLDER =
  /\[YOUR [^\]]*\]|\[DESCRIBE [^\]]*\]|\[LIST [^\]]*\]/g;

/** Substitute the bracketed profile placeholders. Preserves every other
 * character, including spacing and line breaks, exactly. */
export function substituteProfile(prompt: string, profile: ProfileConfig): string {
  const focusAreas = profile.focusAreas
    .map((area, index) => `${index + 1}) ${area}`)
    .join("\n");
  return prompt
    .replace(NAME_PLACEHOLDER, profile.name)
    .replace(TITLE_PLACEHOLDER, profile.title)
    .replace(COMPANY_PLACEHOLDER, profile.company)
    .replace(WRITING_STYLE_PLACEHOLDER, profile.writingStyle)
    .replace(FOCUS_AREAS_PLACEHOLDER, focusAreas);
}

/** Returns any [YOUR ...], [DESCRIBE ...], or [LIST ...] placeholders that
 * would remain after substitution. */
export function findLeftoverPlaceholders(text: string): string[] {
  return text.match(LEFTOVER_PLACEHOLDER) ?? [];
}

/** Substitute and reject leftover placeholders with INVALID_CONFIGURATION. */
export function substituteProfileStrict(prompt: string, profile: ProfileConfig): string {
  const substituted = substituteProfile(prompt, profile);
  const leftovers = findLeftoverPlaceholders(substituted);
  if (leftovers.length > 0) {
    throw new WorkflowError(
      "INVALID_CONFIGURATION",
      `Profile is missing values for prompt placeholders: ${[...new Set(leftovers)].join(", ")}`
    );
  }
  return substituted;
}

/** Runs after substitution on every AI prompt. */
export function validateProfileCompleteness(
  prompts: string[],
  profile: ProfileConfig
): string[] {
  const errors: string[] = [];
  for (const prompt of prompts) {
    for (const leftover of findLeftoverPlaceholders(substituteProfile(prompt, profile))) {
      errors.push(leftover);
    }
  }
  return [...new Set(errors)];
}
