import {
  clampThinkingLevel,
  createModels,
  getSupportedThinkingLevels,
  hasApi,
  type Model,
  type ModelThinkingLevel,
  type Models,
} from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ModelsConfig } from "@chief-of-staff/contracts";
import { WorkflowError } from "@chief-of-staff/workflow/browser";

/** Map the workflow's reasoning-effort vocabulary to pi thinking levels. */
export function mapReasoningEffort(effort: string | null): ModelThinkingLevel {
  if (effort === null) {
    return "low";
  }
  const normalized = effort.toLowerCase() as ModelThinkingLevel;
  return normalized;
}

export interface PiRuntime {
  models: Models;
  model: Model<string>;
  thinkingLevel: ModelThinkingLevel;
}

export interface PiInitOptions {
  modelsConfig: ModelsConfig;
  apiKeyPresent: boolean;
  liveMode: boolean;
}

export interface PiStartupCheck {
  modelFound: boolean;
  supportsToolCalls: boolean;
  effortSupported: boolean;
  apiKeyPresent: boolean;
  violations: string[];
}

export const GEMINI_3_7_FLASH_MODEL = {
  id: "google/gemini-3.7-flash",
  name: "Google: Gemini 3.7 Flash",
  api: "openai-completions",
  baseUrl: "https://openrouter.ai/api/v1",
  provider: "openrouter",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0.05,
    output: 0.15,
    cacheRead: 0.025,
    cacheWrite: 0,
  },
  contextWindow: 1048576,
  maxTokens: 65536,
  compat: {
    supportsDeveloperRole: false,
    thinkingFormat: "openrouter",
  },
} as unknown as Model<string>;

export function createPiModels(): Models {
  const base = openrouterProvider();
  const models = createModels();
  models.setProvider({
    ...base,
    getModels: () => [...base.getModels(), GEMINI_3_7_FLASH_MODEL],
  });
  return models;
}

/** Register only the OpenRouter provider (section 14.1). */
export function initPiRuntime(opts: PiInitOptions): PiRuntime {
  const models = createPiModels();
  const model = models.getModel("openrouter", opts.modelsConfig.model);
  if (!model) {
    throw new WorkflowError(
      "OPENROUTER_MODEL_UNAVAILABLE",
      `Configured OpenRouter model "${opts.modelsConfig.model}" is not in the pi catalog`
    );
  }
  return {
    models,
    model: model as Model<string>,
    thinkingLevel: mapReasoningEffort(opts.modelsConfig.reasoningEffort),
  };
}

/**
 * Required startup checks for live mode (section 15.1). The API key resolves
 * only from the service process environment variable OPENROUTER_API_KEY.
 */
export function runStartupChecks(opts: PiInitOptions): PiStartupCheck {
  const violations: string[] = [];
  let modelFound = false;
  let supportsToolCalls = false;
  let effortSupported = false;

  const models = createPiModels();
  const model = models.getModel("openrouter", opts.modelsConfig.model);
  modelFound = model !== undefined;
  if (!modelFound) {
    violations.push(`model "${opts.modelsConfig.model}" is not in the pi catalog`);
  }
  if (model) {
    supportsToolCalls = hasApi(model, "openai-completions");
    if (!supportsToolCalls) {
      violations.push(`model "${opts.modelsConfig.model}" does not expose the completions API used for tool calling`);
    }
    const supported = getSupportedThinkingLevels(model);
    const requested = mapReasoningEffort(opts.modelsConfig.reasoningEffort);
    const clamped = clampThinkingLevel(model, requested);
    effortSupported = clamped === requested;
    if (!effortSupported) {
      violations.push(
        `reasoning effort "${opts.modelsConfig.reasoningEffort ?? "null"}" is not supported by the model (supported: ${supported.join(", ")})`
      );
    }
  }
  if (!opts.apiKeyPresent) {
    violations.push("OpenRouter API key is not present in the service environment");
  }
  return {
    modelFound,
    supportsToolCalls,
    effortSupported,
    apiKeyPresent: opts.apiKeyPresent,
    violations,
  };
}

export const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;
