import type { PersonProfile, PersonResearchLead } from "@chief-of-staff-demo/shared";
import { scoreLead, type SelectionContext } from "./research-plan.js";
import type { ResearchAllowance } from "./research.js";

/**
 * The three policies one continuous research operation runs under.
 *
 * They used to be closures inside `PersonResearch.run`, which made them
 * unreachable except by driving a whole research operation: to ask what the
 * budget would do at its ceiling, or which leads selection would defer, you had
 * to run research and infer the answer from its report. Naming them here does
 * not change any of those answers — the existing suites are the specification —
 * it makes each one askable on its own.
 */

/**
 * Allowance policy: what one operation may spend before it is bounded.
 *
 * Every ceiling here is a safety bound, never a definition of "done". Reaching
 * one concludes the operation `bounded` with its pending leads intact; only the
 * completion conditions can conclude `completed`. The first bound reached is
 * the one reported, because that is the one that actually stopped the work.
 */
export class ResearchBudget {
  private requests = 0;
  private modelCalls = 0;
  private readonly startedAtMs: number;
  private boundReason: string | null = null;

  constructor(
    private readonly allowance: ResearchAllowance,
    private readonly options: {
      /** Whether the operation is still live; an interruption is not a bound. */
      active: () => boolean;
      now?: () => number;
    },
  ) {
    this.startedAtMs = (options.now ?? Date.now)();
  }

  /** Why the operation stopped short, or null while it still has room. */
  get reason(): string | null {
    return this.boundReason;
  }

  get spentRequests(): number {
    return this.requests;
  }

  get spentModelCalls(): number {
    return this.modelCalls;
  }

  /** Room left, without reserving any of it. */
  within(): boolean {
    const now = (this.options.now ?? Date.now)();
    if (now - this.startedAtMs >= this.allowance.maxMilliseconds) {
      this.boundReason ??=
        "The operation's wall-clock backstop was reached with work still pending.";
      return false;
    }
    if (this.requests >= this.allowance.maxRequests) {
      this.boundReason ??= "The operation's request ceiling was reached with work still pending.";
      return false;
    }
    if (this.modelCalls >= this.allowance.maxModelCalls) {
      this.boundReason ??=
        "The operation's model-call ceiling was reached with work still pending.";
      return false;
    }
    return true;
  }

  /** Reserve one network request, or record why it was refused. */
  takeRequest(): boolean {
    if (!this.within() || !this.options.active()) return false;
    if (!this.allowance.reserveRequest()) {
      this.boundReason ??= "The Workspace declined a further research request.";
      return false;
    }
    this.requests += 1;
    return true;
  }

  /** Reserve one model call, or record why it was refused. */
  takeModelCall(): boolean {
    if (!this.within() || !this.options.active()) return false;
    if (!this.allowance.reserveModelCall()) {
      this.boundReason ??= "The Workspace declined a further model call.";
      return false;
    }
    this.modelCalls += 1;
    return true;
  }
}

/** What one round decided to read, and what it left pending with its score. */
export interface ReadBatchSelection {
  batch: PersonResearchLead[];
  /** Discovered, scored, and not read this round. Never dropped. */
  deferred: PersonResearchLead[];
}

/**
 * Collection policy: which of the discovered leads this round reads.
 *
 * Registration order is not the rule any more. Everything discovered is scored
 * against relevance, independence and unfilled coverage; the batch is the best
 * of it, and the rest stays pending with its score recorded rather than being
 * silently dropped — a URL discarded before retrieval has to stay visible as
 * its own decision.
 */
export function selectReadBatch(input: {
  profile: PersonProfile;
  candidates: PersonResearchLead[];
  /** Coverage areas not yet satisfied, which raise a lead's score. */
  unsatisfied: Set<string>;
  /** Discovery context per lead id, as its rank, title and snippet. */
  context: (leadId: string, target: string) => { title: string; snippet: string; rank: number };
  readHosts: Map<string, number>;
  readIndexes: Map<string, number>;
  readConcurrency: number;
  /** Records the score against the lead, so a deferral keeps its reason. */
  score: (leadId: string, selection: NonNullable<PersonResearchLead["selection"]>) => void;
}): ReadBatchSelection {
  for (const lead of input.candidates) {
    const context = input.context(lead.id, lead.target);
    const selection: SelectionContext = {
      profile: input.profile,
      readHosts: input.readHosts,
      readIndexes: input.readIndexes,
      unsatisfied: input.unsatisfied,
      rank: context.rank,
      title: context.title,
      snippet: context.snippet,
    };
    input.score(lead.id, scoreLead(lead, selection));
  }
  /* Two batches' worth of leads per round: enough that a stalled read does not
     leave the readers idle, few enough that a round still re-scores against
     what the previous one learned. */
  const ranked = [...input.candidates].sort(
    (a, b) => (b.selection?.score ?? 0) - (a.selection?.score ?? 0),
  );
  const size = Math.max(1, input.readConcurrency * 2);
  /* The deferred stay in score order too: their records are what a developer
     reads to see which URL was discovered and not retrieved, and the ranking
     is the reason it was not. */
  return { batch: ranked.slice(0, size), deferred: ranked.slice(size) };
}

/**
 * Publication policy: one writer at a time into the dossier.
 *
 * Reading is parallel and publication is not. The dossier store publishes
 * against an expected revision, so two batch members finishing together would
 * otherwise race each other into a conflict that looks like a lifecycle event.
 * A failed publication does not poison the queue behind it.
 */
export class PublicationGate {
  private tail: Promise<void> = Promise.resolve();

  publish<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
