import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
  ContentResearchBaseline,
  ContentResearchScheduleState,
  NamedPerson,
  PersonSuggestion,
  SourceItem,
} from "@chief-of-staff-demo/shared";

interface ContentResearchLedgerRef {
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
}

interface ContentResearchState {
  people: NamedPerson[];
  suggestions: PersonSuggestion[];
  baselines: ContentResearchBaseline[];
  schedule: ContentResearchScheduleState;
  ledger: ContentResearchLedgerRef;
}

const EMPTY: ContentResearchState = {
  people: [],
  suggestions: [],
  baselines: [],
  schedule: {
    lastSuccessfulDailyPeriod: null,
    lastSuccessfulDiscoveryPeriod: null,
    lastDailyCheckpoint: null,
  },
  ledger: { spreadsheetId: null, spreadsheetUrl: null },
};

function identifier(prefix: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
  return `${prefix}_${stamp}_${randomBytes(4).toString("hex")}`;
}

/** The distinct site origins a set of URLs points at; unparseable URLs are not sites. */
function originsOf(urls: string[]): string[] {
  const origins = new Set<string>();
  for (const value of urls) {
    try {
      origins.add(`${new URL(value).origin}/`);
    } catch {
      // a supporting reference that is not a URL is not a site either
    }
  }
  return [...origins];
}

export class ContentResearchStore {
  private readonly root: string;
  private readonly stateFile: string;
  private readonly itemsDir: string;

  constructor(
    workspaceDir: string,
    private readonly now: () => Date,
  ) {
    this.root = join(workspaceDir, "content-research");
    this.stateFile = join(this.root, "people.json");
    this.itemsDir = join(this.root, "items");
  }

  private readState(): ContentResearchState {
    if (!existsSync(this.stateFile)) return structuredClone(EMPTY);
    try {
      const raw = readFileSync(this.stateFile, "utf8");
      const parsed = JSON.parse(raw) as Partial<ContentResearchState>;
      return {
        people: Array.isArray(parsed.people) ? parsed.people : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        baselines: Array.isArray(parsed.baselines) ? parsed.baselines : [],
        schedule: parsed.schedule ?? structuredClone(EMPTY.schedule),
        ledger: parsed.ledger ?? structuredClone(EMPTY.ledger),
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private writeState(state: ContentResearchState): void {
    mkdirSync(this.root, { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmp, this.stateFile);
  }

  private writeAtomic(path: string, content: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  }

  // Named People

  addPerson(input: {
    name: string;
    handleHints?: NamedPerson["handleHints"];
    discoveredSourceTargets?: NamedPerson["discoveredSourceTargets"];
  }): NamedPerson {
    const state = this.readState();
    const existing = state.people.find(
      (p) => p.name.toLowerCase() === input.name.toLowerCase() && p.archivedAt === null,
    );
    if (existing) return existing;
    const person: NamedPerson = {
      id: identifier("person", this.now()),
      name: input.name,
      handleHints: {
        ...input.handleHints,
        blogRssHints: input.handleHints?.blogRssHints ?? [],
      },
      discoveredSourceTargets: input.discoveredSourceTargets ?? [],
      createdAt: this.now().toISOString(),
      archivedAt: null,
    };
    state.people.push(person);
    this.writeState(state);
    return person;
  }

  listPeople(): NamedPerson[] {
    return this.readState().people.filter((p) => p.archivedAt === null);
  }

  listAllPeople(): NamedPerson[] {
    return this.readState().people;
  }

  getPerson(id: string): NamedPerson | null {
    return this.readState().people.find((p) => p.id === id) ?? null;
  }

  archivePerson(id: string): NamedPerson {
    const state = this.readState();
    const person = state.people.find((p) => p.id === id);
    if (!person) throw new Error(`Named Person not found: ${id}`);
    person.archivedAt = this.now().toISOString();
    this.writeState(state);
    return person;
  }

  updatePersonSourceTargets(
    id: string,
    discovered: NamedPerson["discoveredSourceTargets"],
  ): NamedPerson {
    const state = this.readState();
    const person = state.people.find((p) => p.id === id);
    if (!person) throw new Error(`Named Person not found: ${id}`);
    person.discoveredSourceTargets = discovered;
    this.writeState(state);
    return person;
  }

  // Suggestions

  listSuggestions(): PersonSuggestion[] {
    return this.readState().suggestions;
  }

  saveSuggestions(
    proposals: Omit<
      PersonSuggestion,
      "id" | "state" | "discoveredAt" | "decidedAt" | "decisionReason"
    >[],
  ): PersonSuggestion[] {
    const state = this.readState();
    const blockedNames = new Set([
      ...state.people.map((p) => p.name.toLowerCase()),
      ...state.suggestions.filter((s) => s.state === "dismissed").map((s) => s.name.toLowerCase()),
    ]);
    const added: PersonSuggestion[] = [];
    for (const proposal of proposals) {
      /* A Person Suggestion is blocked by name: already watched, or dismissed
         and not yet restored (spec #116 story 23). Restoring clears the block
         because the suggestion returns to pending. */
      if (blockedNames.has(proposal.name.toLowerCase())) continue;
      const suggestion: PersonSuggestion = {
        ...proposal,
        id: identifier("suggestion", this.now()),
        state: "pending",
        discoveredAt: this.now().toISOString(),
        decidedAt: null,
        decisionReason: null,
      };
      state.suggestions.push(suggestion);
      added.push(suggestion);
      blockedNames.add(proposal.name.toLowerCase());
    }
    if (added.length > 0) this.writeState(state);
    return added;
  }

  decideSuggestion(
    id: string,
    decision: "approved" | "dismissed" | "pending",
    reason: string | null,
  ): PersonSuggestion {
    const state = this.readState();
    const suggestion = state.suggestions.find((s) => s.id === id);
    if (!suggestion) throw new Error(`Person Suggestion not found: ${id}`);
    suggestion.state = decision;
    suggestion.decidedAt = this.now().toISOString();
    suggestion.decisionReason = reason;
    if (decision === "approved") {
      const exists = state.people.find(
        (p) => p.name.toLowerCase() === suggestion.name.toLowerCase(),
      );
      if (!exists) {
        /* The sites behind the supporting URLs are what the suggestion actually
           evidenced, so the approved person starts watched on them. Their feeds
           are resolved separately, by fetching each site (spec #116 story 24). */
        const person: NamedPerson = {
          id: identifier("person", this.now()),
          name: suggestion.name,
          handleHints: { blogRssHints: [] },
          discoveredSourceTargets: originsOf(suggestion.supportingUrls).map((url) => ({
            adapterId: "website",
            url,
            label: `${suggestion.name} website`,
          })),
          createdAt: this.now().toISOString(),
          archivedAt: null,
        };
        state.people.push(person);
      }
    }
    this.writeState(state);
    return suggestion;
  }

  restoreSuggestion(id: string): PersonSuggestion {
    const state = this.readState();
    const suggestion = state.suggestions.find((s) => s.id === id);
    if (!suggestion) throw new Error(`Person Suggestion not found: ${id}`);
    if (suggestion.state !== "dismissed")
      throw new Error(`Only dismissed suggestions can be restored`);
    suggestion.state = "pending";
    suggestion.decidedAt = null;
    suggestion.decisionReason = null;
    this.writeState(state);
    return suggestion;
  }

  // Baselines

  getBaseline(personId: string): ContentResearchBaseline | null {
    return this.readState().baselines.find((b) => b.personId === personId) ?? null;
  }

  listBaselines(): ContentResearchBaseline[] {
    return this.readState().baselines;
  }

  recordBaseline(personId: string, weightedCounts: number[]): ContentResearchBaseline {
    const state = this.readState();
    let baseline = state.baselines.find((b) => b.personId === personId);
    if (!baseline) {
      baseline = {
        personId,
        history: [],
        mean: 0,
        stdDev: 0,
        updatedAt: this.now().toISOString(),
      };
      state.baselines.push(baseline);
    }
    // Keep last 90 values (daily aggregates)
    baseline.history.push(...weightedCounts);
    if (baseline.history.length > 90) {
      baseline.history = baseline.history.slice(-90);
    }
    const n = baseline.history.length;
    const mean = n === 0 ? 0 : baseline.history.reduce((a, b) => a + b, 0) / n;
    const variance =
      n <= 1 ? 0 : baseline.history.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
    baseline.mean = mean;
    baseline.stdDev = Math.sqrt(variance);
    baseline.updatedAt = this.now().toISOString();
    this.writeState(state);
    return baseline;
  }

  // Schedule / checkpoint

  scheduleState(): ContentResearchScheduleState {
    return this.readState().schedule;
  }

  recordSuccessfulPeriod(kind: "daily" | "discovery", period: string): void {
    const state = this.readState();
    if (kind === "daily") state.schedule.lastSuccessfulDailyPeriod = period;
    if (kind === "discovery") state.schedule.lastSuccessfulDiscoveryPeriod = period;
    this.writeState(state);
  }

  setDailyCheckpoint(checkpoint: string | null): void {
    const state = this.readState();
    state.schedule.lastDailyCheckpoint = checkpoint;
    this.writeState(state);
  }

  getDailyCheckpoint(): string | null {
    return this.readState().schedule.lastDailyCheckpoint;
  }

  // Items sharded store (raw SourceItems)

  storeItems(items: { canonicalUrl: string; payload: string }[]): void {
    mkdirSync(this.itemsDir, { recursive: true });
    for (const { canonicalUrl, payload } of items) {
      const hash = Buffer.from(canonicalUrl).toString("base64url").slice(0, 16);
      const path = join(this.itemsDir, `${hash}.json`);
      this.writeAtomic(path, payload);
    }
  }

  /** Collected Source Items, newest first, bounded — discovery reads receipts, not the whole corpus. */
  listItems(limit = 100): SourceItem[] {
    if (!existsSync(this.itemsDir)) return [];
    const items: SourceItem[] = [];
    for (const file of readdirSync(this.itemsDir)) {
      try {
        items.push(JSON.parse(readFileSync(join(this.itemsDir, file), "utf8")) as SourceItem);
      } catch {
        // a torn write is never worth failing a discovery run over
      }
    }
    items.sort((a, b) => (a.discoveredAt < b.discoveredAt ? 1 : -1));
    return items.slice(0, limit);
  }

  // Ledger spreadsheet reference

  getLedger(): ContentResearchLedgerRef {
    return this.readState().ledger;
  }

  setLedger(ledger: ContentResearchLedgerRef): void {
    const state = this.readState();
    state.ledger = ledger;
    this.writeState(state);
  }
}
