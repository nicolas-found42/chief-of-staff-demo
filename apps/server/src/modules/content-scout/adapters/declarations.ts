import type { SourceAdapterCanaryTarget } from "@chief-of-staff-demo/shared";
import type { SourceAdapter, SourceCollectionResult } from "../ports.js";

/** Honest visible declaration for an adapter with no runnable public route yet. */
export class ComingLaterSourceAdapter implements SourceAdapter {
  readonly state = "coming_later" as const;
  readonly version = "not-implemented";
  constructor(readonly id: string) {}
  get canaryTargets(): readonly SourceAdapterCanaryTarget[] {
    return this.id === "linkedin"
      ? [
          {
            adapterId: "linkedin",
            label: "Microsoft",
            url: "https://www.linkedin.com/company/microsoft/",
          },
          {
            adapterId: "linkedin",
            label: "Google",
            url: "https://www.linkedin.com/company/google/",
          },
          {
            adapterId: "linkedin",
            label: "LinkedIn",
            url: "https://www.linkedin.com/company/linkedin/",
          },
        ]
      : [];
  }

  supports(target: { adapterId: string }): boolean {
    return target.adapterId === this.id;
  }

  async collect(): Promise<SourceCollectionResult> {
    throw new Error(`${this.id} is Coming later and cannot collect Source Targets.`);
  }
}
