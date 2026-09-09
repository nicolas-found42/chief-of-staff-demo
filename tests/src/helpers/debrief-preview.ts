import type { FastifyInstance } from "fastify";

/** Exercise approval through the public preview contract, including repeat/refusal cases. */
export async function debriefPreviewInput(app: FastifyInstance, runId: string) {
  const response = await app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}/email` });
  const options = response.json() as { candidates?: { id: string; includedByDefault: boolean }[] };
  const selectedIds = (options.candidates ?? [])
    .filter((candidate) => candidate.includedByDefault)
    .map((candidate) => candidate.id);
  const preview = await app.inject({
    method: "POST",
    url: `/api/meeting-debrief/${runId}/preview`,
    payload: { selectedIds },
  });
  return {
    selectedIds,
    revision: preview.json<{ revision?: string }>().revision ?? "unavailable",
  };
}
