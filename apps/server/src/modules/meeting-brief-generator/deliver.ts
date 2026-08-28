import type { RunContext } from "../../engine/module.js";
import type {
  MeetingBrief,
  MeetingBriefDeliveryState,
  MeetingBriefRunResult,
  MeetingBriefEvent,
} from "@chief-of-staff-demo/shared";
import { meetingBriefOccurrenceIdentity } from "@chief-of-staff-demo/shared";
import { StageFailure } from "../../engine/module.js";
import { isEligibleMeeting } from "./eligibility.js";
import type { CalendarProvider } from "./calendar.js";
import type { GmailDeliveryProvider } from "./google/gmailDelivery.js";
import { renderMeetingBriefEmail } from "./output.js";
import { materialFingerprint } from "./revision.js";

/**
 * Stable idempotency key for a Run. Persisted before the outward Gmail write.
 * Occurrence + eventVersion is stable across retries of the same Run; runId would also work
 * but this key is deterministic even before the Run id is known in some paths.
 */
export function deliveryIdFor(occurrenceKey: string, eventVersion: string): string {
  // Sanitize: occurrenceKey already `eventId::occurrenceId`, version is opaque string
  return `mb-deliver-${occurrenceKey}-${eventVersion}`;
}

export function deliveryState(
  status: MeetingBriefDeliveryState["status"],
  deliveryId: string,
  fields: Partial<Omit<MeetingBriefDeliveryState, "status" | "deliveryId">> = {},
): MeetingBriefDeliveryState {
  return {
    status,
    sentAt: null,
    messageId: null,
    recipient: null,
    attempts: 0,
    deliveryId,
    ...fields,
  };
}

export interface DeliverBriefArgs {
  ctx: RunContext;
  brief: MeetingBrief;
  input: MeetingBriefEvent & { occurrenceKey: string; supersedesRunId?: string | null };
  occurrenceKey: string;
  now: () => Date;
  calendarProvider?: CalendarProvider | null;
  gmailDeliveryProvider?: GmailDeliveryProvider | null;
  getInternalDomains?: () => string[];
  getOwnerEmail?: () => string | null;
}

export interface DeliverResult {
  skipped: boolean;
  superseded: boolean;
  skipReason: string | null;
  delivery: MeetingBriefDeliveryState | null;
}

function deliveryAttempts(ctx: RunContext): number {
  const raw = ctx.readFile("delivery.json");
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as { attempts?: unknown };
    return typeof parsed.attempts === "number" ? parsed.attempts : 0;
  } catch {
    return 0;
  }
}

function persistDelivery(
  ctx: RunContext,
  delivery: MeetingBriefDeliveryState,
  audit: Record<string, unknown> = {},
  resultPatch: Partial<MeetingBriefRunResult> = {},
): void {
  ctx.writeFile("delivery.json", JSON.stringify({ ...delivery, ...audit }, null, 2) + "\n");
  const previous = ctx.readFile("result.json");
  if (!previous) return;
  try {
    const result = JSON.parse(previous) as MeetingBriefRunResult;
    ctx.writeFile(
      "result.json",
      JSON.stringify({ ...result, ...resultPatch, delivery }, null, 2) + "\n",
    );
  } catch {
    // A corrupt result remains a Run-level failure; delivery state is still durable.
  }
}

function persistDeliveryFailure(
  ctx: RunContext,
  deliveryId: string,
  attempts: number,
  error: string,
): MeetingBriefDeliveryState {
  const failed = deliveryState("failed", deliveryId, { attempts });
  persistDelivery(ctx, failed, { error });
  ctx.event("brief_delivery_failed", { deliveryId, error, attempts });
  return failed;
}

/**
 * Execute the `deliver` Stage with ADR-0034 guarantees:
 * - Rechecks current revision (still latest) and eligibility before outward write
 * - Persists stable delivery identity before send
 * - Reconciles Gmail sent state before retry (lost ack converges to one message)
 * - Failure preserves Meeting Brief and allows retry of deliver only
 * - Owner-only recipient, never External Guest, no recipient field from model/event
 */
export async function executeDeliver(args: DeliverBriefArgs): Promise<DeliverResult> {
  const {
    ctx,
    brief,
    input,
    occurrenceKey,
    now,
    calendarProvider,
    gmailDeliveryProvider,
    getInternalDomains,
    getOwnerEmail,
  } = args;
  const resolveDomains = (): string[] => (getInternalDomains ? getInternalDomains() : []);
  const resolveOwner = (): string | null => (getOwnerEmail ? getOwnerEmail() : null);
  const deliveryId = deliveryIdFor(occurrenceKey, brief.eventVersion);

  // ---- Current Calendar truth: fetched once, shared by the quiet gate and the pre-send recheck.
  // The quiet gate must consult this fresh state (not the snapshot-frozen start): a material
  // move that lands while the Run is mid-flight can put the meeting inside the five-minute
  // window before deliver first runs.
  let currentEvent: MeetingBriefEvent | null = null;
  let calendarRecheckError: string | null = null;
  if (calendarProvider) {
    try {
      const result = await calendarProvider.listEvents({
        calendarId: input.calendarId,
        syncToken: null,
      });
      currentEvent =
        result.events.find(
          (event) =>
            meetingBriefOccurrenceIdentity(event.eventId, event.occurrenceId).occurrenceKey ===
            occurrenceKey,
        ) ?? null;
    } catch (error) {
      calendarRecheckError = error instanceof Error ? error.message : String(error);
    }
  }

  // ---- Quiet period for revisions (ADR-0034) ----
  // First brief sends immediately; revision waits 5 min unless meeting is within 5 min.
  // isRevision must survive resume (planResume stub input has no supersedes) — check result.json fallback.
  let isRevision = Boolean(input.supersedesRunId);
  if (!isRevision) {
    const resultRawForRevision = ctx.readFile("result.json");
    if (resultRawForRevision) {
      try {
        const parsed = JSON.parse(resultRawForRevision) as { supersedes?: string | null };
        if (parsed.supersedes) isRevision = true;
      } catch {
        // ignore
      }
    }
  }
  const gateStart = currentEvent?.startAt ?? brief.logistics.startAt;
  const startMs = Date.parse(gateStart);
  const nowMs = now().getTime();
  const timeUntilStart = Number.isNaN(startMs) ? 0 : startMs - nowMs;
  const shouldWaitForQuiet = isRevision && timeUntilStart > 5 * 60 * 1000;
  if (shouldWaitForQuiet) {
    const existingRaw = ctx.readFile("delivery.json");
    let alreadyWaited = false;
    if (existingRaw) {
      try {
        const existing = JSON.parse(existingRaw) as MeetingBriefDeliveryState & {
          quietWaitScheduledAt?: string;
        };
        if (existing.quietWaitScheduledAt) alreadyWaited = true;
      } catch {
        // ignore
      }
    }
    if (!alreadyWaited) {
      const pending = deliveryState("pending", deliveryId);
      persistDelivery(ctx, pending, { quietWaitScheduledAt: now().toISOString() });
      ctx.event("brief_quiet_wait", { deliveryId, waitMs: 5 * 60 * 1000, startAt: gateStart });
      ctx.wait({
        reason: "quiet_period",
        timeout: { kind: "at", at: new Date(nowMs + 5 * 60 * 1000).toISOString() },
      });
    }
  }

  // A failed fetch is surfaced here, at the pre-send recheck point.
  if (calendarProvider && calendarRecheckError !== null) {
    persistDeliveryFailure(ctx, deliveryId, deliveryAttempts(ctx) + 1, calendarRecheckError);
    throw new StageFailure("deliver", `Calendar recheck failed: ${calendarRecheckError}`);
  }

  // ---- Recheck eligibility + revision immediately before outward write ----
  if (calendarProvider) {
    try {
      const current = currentEvent ?? undefined;
      const domains = resolveDomains();
      const owner = resolveOwner();
      const reason =
        current === undefined
          ? "occurrence_not_found"
          : current.status === "cancelled"
            ? "cancelled"
            : !isEligibleMeeting(current, domains, owner)
              ? "not_eligible_at_delivery"
              : null;
      if (reason) {
        const skippedDelivery = deliveryState("skipped", deliveryId);
        persistDelivery(
          ctx,
          skippedDelivery,
          { skippedReason: reason },
          { deliverySkippedReason: reason },
        );
        ctx.event("brief_delivery_skipped", { occurrenceKey, reason });
        return { skipped: true, superseded: false, skipReason: reason, delivery: skippedDelivery };
      }

      // Obsolete revision: material fingerprint differs from frozen snapshot → superseded
      // Ignored metadata (colorId/visibility) does not cause supersession.
      if (current) {
        let isSuperseded = false;
        let frozenFingerprint: string | null = null;
        try {
          const snapRaw = ctx.readFile("snapshot.json");
          if (snapRaw) {
            const snap = JSON.parse(snapRaw) as { materialFingerprint?: string; version?: string };
            if (typeof snap.materialFingerprint === "string")
              frozenFingerprint = snap.materialFingerprint;
          }
        } catch {
          // ignore
        }
        if (frozenFingerprint !== null) {
          const currentFingerprint = materialFingerprint(current);
          isSuperseded = currentFingerprint !== frozenFingerprint;
        } else {
          // Fallback for old snapshots without fingerprint: version comparison
          isSuperseded = current.version !== brief.eventVersion;
        }
        if (isSuperseded) {
          const currentFingerprintForLog = materialFingerprint(current);
          const supersededDelivery = deliveryState("superseded", deliveryId);
          persistDelivery(ctx, supersededDelivery, {
            supersededReason: "obsolete_revision",
            currentVersion: current.version,
            currentFingerprint: currentFingerprintForLog,
            frozenFingerprint,
          });
          ctx.event("brief_superseded", {
            occurrenceKey,
            eventVersion: brief.eventVersion,
            currentVersion: current.version,
            currentFingerprint: currentFingerprintForLog,
            frozenFingerprint,
            reason: "obsolete_revision",
          });
          ctx.event("delivery_superseded", {
            occurrenceKey,
            eventVersion: brief.eventVersion,
            currentVersion: current.version,
            currentFingerprint: currentFingerprintForLog,
            frozenFingerprint,
            reason: "obsolete_revision",
            deliveryId,
          });
          return {
            skipped: false,
            superseded: true,
            skipReason: "obsolete_revision",
            delivery: supersededDelivery,
          };
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      persistDeliveryFailure(ctx, deliveryId, deliveryAttempts(ctx) + 1, reason);
      throw new StageFailure("deliver", `Calendar recheck failed: ${reason}`);
    }
  }

  // ---- Stable identity persisted before send ----
  const existingRaw = ctx.readFile("delivery.json");
  let existingDelivery:
    | (MeetingBriefDeliveryState & {
        error?: string;
        skippedReason?: string;
        supersededReason?: string;
      })
    | null = null;
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw) as MeetingBriefDeliveryState & { error?: string };
      existingDelivery = parsed;
    } catch {
      existingDelivery = null;
    }
  }
  // Persist the stable identity before reconciling or sending.
  const shouldPersistPending =
    !existingDelivery ||
    !existingDelivery.deliveryId ||
    existingDelivery.deliveryId !== deliveryId ||
    existingDelivery.status === "failed" ||
    existingDelivery.status === "pending";
  if (shouldPersistPending) {
    const pending = deliveryState("pending", deliveryId, {
      attempts: existingDelivery?.attempts ?? 0,
    });
    persistDelivery(ctx, pending);
    // For type flow, treat existingDelivery as pending now
    existingDelivery = { ...pending, attempts: pending.attempts };
  }

  // ---- Reconcile Gmail sent state before retry (lost ack convergence) ----
  if (gmailDeliveryProvider) {
    try {
      const reconciled = await gmailDeliveryProvider.findByDeliveryId(deliveryId);
      if (reconciled) {
        const reconciledDelivery = deliveryState("reconciled", deliveryId, {
          sentAt: now().toISOString(),
          messageId: reconciled.messageId,
          recipient: reconciled.recipient,
          attempts: (existingDelivery?.attempts ?? 0) + 1,
        });
        persistDelivery(ctx, reconciledDelivery);
        ctx.event("brief_reconciled", {
          deliveryId,
          messageId: reconciled.messageId,
          recipient: reconciled.recipient,
        });
        return {
          skipped: false,
          superseded: false,
          skipReason: null,
          delivery: reconciledDelivery,
        };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      persistDeliveryFailure(ctx, deliveryId, (existingDelivery?.attempts ?? 0) + 1, reason);
      throw new StageFailure("deliver", `Gmail reconciliation failed: ${reason}`);
    }
  }

  // ---- Render concise plain-text/HTML email ----
  const rendered = renderMeetingBriefEmail(brief, isRevision);

  // ---- Send ----
  let messageId: string;
  let recipient: string;
  const attemptsBefore = existingDelivery?.attempts ?? 0;
  try {
    if (gmailDeliveryProvider) {
      const sent = await gmailDeliveryProvider.send({
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        deliveryId,
      });
      messageId = sent.messageId;
      recipient = sent.recipient;
    } else {
      throw new Error("Gmail Output Adapter is unavailable");
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const attempts = attemptsBefore + 1;
    persistDeliveryFailure(ctx, deliveryId, attempts, reason);
    // Preserve brief, fail only deliver Stage
    throw new StageFailure("deliver", reason);
  }

  // ---- Persist sent identity ----
  const sentAt = now().toISOString();
  const sent = deliveryState("sent", deliveryId, {
    sentAt,
    messageId,
    recipient,
    attempts: attemptsBefore + 1,
  });
  persistDelivery(ctx, sent);
  ctx.event("brief_delivered", { deliveryId, messageId, recipient });
  return { skipped: false, superseded: false, skipReason: null, delivery: sent };
}
