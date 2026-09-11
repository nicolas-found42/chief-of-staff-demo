import { readFileSync } from "node:fs";
import { z } from "zod/v3";
import type { SourceLifecycleGrant } from "@chief-of-staff-demo/shared";

/**
 * Reads the frozen authorization a live campaign dispatches under (#363).
 *
 * The grant file is owner-authored private input: the harness validates its
 * structure, verifies it at dispatch through the budget ledger, and records its
 * identity in the manifest — never its contents.
 */
const SourceLifecycleGrantFileSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  purpose: z.enum(["meeting-debrief", "validation-campaign"]),
  grantedBy: z.string().min(1).default("owner"),
  grantedAt: z.string().default(""),
  revokedAt: z.string().nullable().default(null),
  routePolicy: z.object({
    zdrRequired: z.boolean(),
    dataCollection: z.enum(["deny", "allow"]),
    allowNonZdrException: z.boolean().optional(),
    allowedEndpoints: z.array(z.string()).optional(),
  }),
});

export function readSourceLifecycleGrant(path: string): SourceLifecycleGrant {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read the source lifecycle grant at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const parsed = SourceLifecycleGrantFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `The source lifecycle grant at ${path} is not a valid validation-campaign grant: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "[root]"} ${issue.message}`)
        .join("; ")}`,
    );
  }
  const grant = parsed.data;
  return {
    id: grant.id,
    sourceId: grant.sourceId,
    purpose: grant.purpose,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt,
    revokedAt: grant.revokedAt,
    routePolicy: {
      zdrRequired: grant.routePolicy.zdrRequired,
      dataCollection: grant.routePolicy.dataCollection,
      ...(grant.routePolicy.allowNonZdrException !== undefined
        ? { allowNonZdrException: grant.routePolicy.allowNonZdrException }
        : {}),
      ...(grant.routePolicy.allowedEndpoints !== undefined
        ? { allowedEndpoints: grant.routePolicy.allowedEndpoints }
        : {}),
    },
  };
}
