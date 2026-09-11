import type {
  CampaignCorpusRevision,
  CampaignModelRoute,
  CampaignProtocol,
  CampaignSlot,
  CampaignSlotKind,
} from "@chief-of-staff-demo/shared";

/**
 * Slot allocation for a private validation campaign (#363, MWR-019/020/055).
 *
 * A protocol names its dimensions; the counts come from the frozen corpus
 * revision it is planned against, never from a constant. The recorded baseline
 * (all Goldens plus the incident transcripts, on the three development models)
 * is one instance of this arithmetic: 20 active Goldens and 3 incidents across
 * 3 models plan 69 slots, while a revision holding 21 active Goldens plans 72.
 */

export interface CampaignProtocolShape {
  /** Times each active Golden runs per model and arm. */
  goldenRepetitions: number;
  /** Times each incident case runs cold per model and arm. */
  coldIncidentRepetitions: number;
  /** Times each Brief case runs per model and arm. */
  briefRepetitions: number;
  /** Extractor arms compared in the campaign, in plan order. */
  arms: string[];
}

const INCUMBENT_ARM = "incumbent";

/**
 * Protocol dimensions as settled by the operating contract. A comparison
 * campaign's arms are its two extractors; the final campaign's single arm is
 * the selected design. Case selection stays with the caller.
 */
export function defaultProtocolShape(protocol: CampaignProtocol): CampaignProtocolShape {
  switch (protocol) {
    case "baseline":
      return {
        goldenRepetitions: 1,
        coldIncidentRepetitions: 1,
        briefRepetitions: 0,
        arms: [INCUMBENT_ARM],
      };
    case "comparison":
      return {
        goldenRepetitions: 3,
        coldIncidentRepetitions: 0,
        briefRepetitions: 0,
        arms: [INCUMBENT_ARM, "alternative-a"],
      };
    case "final":
      return {
        goldenRepetitions: 3,
        coldIncidentRepetitions: 0,
        briefRepetitions: 0,
        arms: ["selected"],
      };
    case "brief":
      return {
        goldenRepetitions: 0,
        coldIncidentRepetitions: 0,
        briefRepetitions: 3,
        arms: [INCUMBENT_ARM],
      };
  }
}

export interface CampaignPlanInput {
  campaignId: string;
  protocol: CampaignProtocol;
  corpus: CampaignCorpusRevision;
  models: readonly CampaignModelRoute[];
  /** Parent directory every slot root is allocated under. */
  coldRoot: string;
  shape?: Partial<CampaignProtocolShape> | undefined;
}

/** A filesystem-safe, separator-free part. `_` is reserved for joining. */
function slugifySlotPart(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9.-]+/g, "-").replaceAll(/^-+|-+$/g, "") || "unnamed";
}

/**
 * Every planned slot, in a stable order: arms, then models, then Golden,
 * incident and Brief groups, each sorted by case id and repetition. Identical
 * inputs plan an identical slot list, which is what makes a frozen manifest
 * comparable to a later request.
 */
export function planCampaignSlots(input: CampaignPlanInput): CampaignSlot[] {
  const shape: CampaignProtocolShape = { ...defaultProtocolShape(input.protocol), ...input.shape };
  const goldenCases = [...input.corpus.goldenCaseIds].sort();
  const incidentCases = [...input.corpus.incidentCaseIds].sort();
  const briefCases = [...input.corpus.briefCaseIds].sort();
  const models = [...input.models];
  const slots: CampaignSlot[] = [];

  const add = (
    kind: CampaignSlotKind,
    model: CampaignModelRoute,
    arm: string,
    caseId: string,
    repetition: number,
    cold: boolean,
  ): void => {
    const slotId = [
      input.protocol,
      kind,
      slugifySlotPart(model.model),
      slugifySlotPart(arm),
      slugifySlotPart(caseId),
      `r${repetition}`,
    ].join("_");
    slots.push({
      slotId,
      protocol: input.protocol,
      kind,
      caseId,
      model: model.model,
      arm,
      repetition,
      cold,
      root: `${input.coldRoot}/${slotId}`,
      operationId: `op_${slotId}`,
    });
  };

  for (const arm of shape.arms) {
    for (const model of models) {
      for (const caseId of goldenCases) {
        for (let repetition = 1; repetition <= shape.goldenRepetitions; repetition++) {
          add("golden", model, arm, caseId, repetition, shape.goldenRepetitions > 1);
        }
      }
      for (const caseId of incidentCases) {
        for (let repetition = 1; repetition <= shape.coldIncidentRepetitions; repetition++) {
          add("incident", model, arm, caseId, repetition, true);
        }
      }
      for (const caseId of briefCases) {
        for (let repetition = 1; repetition <= shape.briefRepetitions; repetition++) {
          add("brief", model, arm, caseId, repetition, shape.briefRepetitions > 1);
        }
      }
    }
  }

  return slots;
}
