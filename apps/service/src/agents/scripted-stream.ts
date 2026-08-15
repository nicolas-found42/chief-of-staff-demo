import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { WorkflowError } from "@chief-of-staff/workflow";

export interface ScriptedTextMessage {
  kind: "text";
  text: string;
}

export interface ScriptedToolCallMessage {
  kind: "toolCall";
  name: string;
  arguments: Record<string, unknown>;
}

export type ScriptedMessage = ScriptedTextMessage | ScriptedToolCallMessage;

export interface ScriptedCase {
  messages: ScriptedMessage[];
}

const FIXED_TIMESTAMP = 0;

function buildScriptedMessage(scripted: ScriptedMessage, caseLabel: string): AssistantMessage {
  if (scripted.kind === "text") {
    return fauxAssistantMessage(fauxText(scripted.text), {
      stopReason: "stop",
      timestamp: FIXED_TIMESTAMP,
    });
  }
  return fauxAssistantMessage(
    fauxToolCall(scripted.name, scripted.arguments, {
      id: `scripted:${caseLabel}:${scripted.name}`,
    }),
    {
      stopReason: "toolUse",
      timestamp: FIXED_TIMESTAMP,
    }
  );
}

/**
 * Deterministic streamFn built on pi's faux/test streaming core. Plays one
 * scripted assistant message; a second stream call fails with a named error
 * naming the exhausted case. Never touches the network.
 */
export function createScriptedStreamFn(
  modelId: string,
  scripted: ScriptedMessage[],
  caseLabel: string
): StreamFn {
  const core = createFauxCore({
    api: "openai-completions",
    provider: "replay",
    models: [
      {
        id: modelId,
        name: "Replay fixture model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 262144,
      },
    ],
    // Fixed token size keeps streaming chunk boundaries (and therefore
    // progress event counts) deterministic for byte-identical replay runs.
    tokenSize: { min: 64, max: 64 },
  });
  if (scripted.length === 0) {
    const empty = fauxAssistantMessage(fauxText(""), {
      stopReason: "error",
      errorMessage: `Replay fixture ${caseLabel} contains no scripted messages`,
      timestamp: FIXED_TIMESTAMP,
    });
    core.setResponses([empty]);
  } else {
    core.setResponses([buildScriptedMessage(scripted[0], caseLabel)]);
  }
  return core.streamSimple as StreamFn;
}

/** Parse a loaded fixture case file into scripted messages. */
export function parseScriptedCase(raw: unknown, caseLabel: string): ScriptedCase {
  if (typeof raw !== "object" || raw === null) {
    throw new WorkflowError(
      "INVALID_REPLAY_FIXTURE",
      `Replay fixture ${caseLabel} is not an object`
    );
  }
  const record = raw as { schemaVersion?: unknown; messages?: unknown };
  if (record.schemaVersion !== 1 || !Array.isArray(record.messages)) {
    throw new WorkflowError(
      "INVALID_REPLAY_FIXTURE",
      `Replay fixture ${caseLabel} must have schemaVersion 1 and a messages array`
    );
  }
  const messages: ScriptedMessage[] = record.messages.map((message, index) => {
    if (typeof message !== "object" || message === null) {
      throw new WorkflowError(
        "INVALID_REPLAY_FIXTURE",
        `Replay fixture ${caseLabel} message ${index} is not an object`
      );
    }
    const item = message as { kind?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
    if (item.kind === "text" && typeof item.text === "string") {
      return { kind: "text", text: item.text };
    }
    if (
      item.kind === "toolCall" &&
      typeof item.name === "string" &&
      typeof item.arguments === "object" &&
      item.arguments !== null
    ) {
      return {
        kind: "toolCall",
        name: item.name,
        arguments: item.arguments as Record<string, unknown>,
      };
    }
    throw new WorkflowError(
      "INVALID_REPLAY_FIXTURE",
      `Replay fixture ${caseLabel} message ${index} is not a valid scripted message`
    );
  });
  return { messages };
}
