import type { PersonClaim, PersonSourceDocument } from "@chief-of-staff-demo/shared";

// Conservative recognition of an explicit relation in prose. This is a
// publication safeguard, not an entailment judge: recognizing a verb does
// not prove a claim true. Unrecognized fragments remain available as claims.
const predicate =
  /\b(?:am|is|are|was|were|has|have|had|built|builds|designed|developed|created|founded|co-founded|joined|led|leads|worked|works|served|serves|appointed|became|launched|released|published|wrote|authored|earned|received|studied|graduated|completed|deployed|maintains|maintained|manages|managed|runs|ran|directs|directed|teaches|taught|researches|researched|invented|discovered|contributed|contributes|supported|says|said|reports|reported|verified|verifies|financed|held|moved|lists|listed|argues|demonstrates|contains|recommends|recommended|executed|operated|remained|began|spent)\b/i;

function hasPredicate(quote: string): boolean {
  const match = predicate.exec(quote);
  return (
    !!match &&
    /[\p{L}\p{N}]/u.test(quote.slice(0, match.index)) &&
    /[\p{L}\p{N}]/u.test(quote.slice(match.index + match[0].length))
  );
}

export function qualifyClaimEvidence(
  claim: PersonClaim,
  source: PersonSourceDocument,
): PersonClaim {
  if (claim.status !== "supported" && claim.status !== "claimed") return claim;
  const publicName = /^Public profile name: (.+)$/m.exec(source.text)?.[1];
  if (
    source.attribution === "self-report" &&
    publicName &&
    claim.fact?.field === "fullName" &&
    claim.fact.value === publicName
  )
    return {
      ...claim,
      statement: `The public profile lists the name ${publicName}.`,
      status: "claimed",
      effectiveFrom: null,
      effectiveTo: null,
      citations: [{ sourceId: source.id, quote: `Public profile name: ${publicName}` }],
      changeReason:
        "Name attributed to the matched public profile heading; no independent verification.",
    };
  const reasons: string[] = [];
  for (const { quote } of claim.citations) {
    const start = source.text.indexOf(quote);
    if (start < 0) continue; // Grounding is checked before this boundary.
    if (source.text.indexOf(quote, start + 1) !== -1)
      reasons.push(
        "The citation occurs more than once and does not identify a unique supporting passage.",
      );
    if (!hasPredicate(quote))
      reasons.push(
        "The citation is a fragment without a recognized predicate; it does not establish the asserted relationship.",
      );
    const lineStart = source.text.lastIndexOf("\n", start) + 1;
    const lineEnd = source.text.indexOf("\n", start + quote.length);
    const passage = source.text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
    if (
      claim.fact &&
      ["role", "currentEmployer"].includes(claim.fact.field) &&
      /(?:…|\.\.\.)/.test(passage) &&
      /\b(?:spent|previously|formerly|worked|was|were|had|used to)\b/i.test(passage)
    )
      reasons.push(
        "The cited passage is truncated and describes a past period; it does not establish a current role or employer.",
      );
  }
  if (
    source.attribution === "self-report" &&
    claim.effectiveFrom === null &&
    /\b(currently|attending|current work)\b/i.test(claim.statement)
  )
    reasons.push(
      "This is an undated self-report; current status has not been independently established.",
    );
  const founding = /\b(?:founded|co-founded|founder|co-founder)\b/i;
  const unestablishedFounding =
    founding.test(claim.statement) && !claim.citations.some(({ quote }) => founding.test(quote));
  if (unestablishedFounding)
    reasons.push(
      "The citation does not establish founding or co-founding; affiliation or teaching is not founding evidence.",
    );
  if (reasons.length === 0) return claim;
  const structured =
    claim.changeReason?.startsWith("Preserved explicit structured fields") ||
    claim.citations.some(
      (c) =>
        claim.statement ===
        c.quote
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .join(" — "),
    );
  const fragmentAssertion =
    source.attribution === "self-report" &&
    hasPredicate(claim.statement) &&
    !structured &&
    claim.citations.every((c) => !hasPredicate(c.quote) && c.quote.trim().length <= 160) &&
    !claim.citations.some((c) => c.quote.trim() === claim.statement.trim());
  const unresolved =
    unestablishedFounding ||
    fragmentAssertion ||
    (claim.fact && ["role", "currentEmployer"].includes(claim.fact.field)) ||
    /\b(currently|attending|current work|current role|current employer|works at|works for)\b/i.test(
      claim.statement,
    );
  return {
    ...claim,
    status: "claimed",
    ...(unresolved ? { effectiveFrom: null, effectiveTo: null } : {}),
    statement: unresolved
      ? `Unresolved source fragment: “${claim.citations
          .map((c) => c.quote.trim().replace(/\s+/g, " "))
          .join("”; “")
          .slice(0, 3000)}”. The asserted relationship and current status are not established.`
      : claim.statement,
    changeReason: [
      ...new Set(reasons),
      `Proposed assertion not established: ${claim.statement}`,
      claim.changeReason,
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 4000),
  };
}

/** Recover only explicit adjacent fields in a LinkedIn profile's structured
 * sections. Never infer an employer, institution, issuer or date from a name. */
export function retainClaimContext(claim: PersonClaim, source: PersonSourceDocument): PersonClaim {
  if (!/^https?:\/\/(?:www\.)?linkedin\.com\/in\//i.test(source.url)) return claim;
  const first = claim.citations[0];
  if (!first) return claim;
  const start = source.text.indexOf(first.quote);
  if (start < 0 || source.text.indexOf(first.quote, start + 1) !== -1) {
    return locationContext(claim);
  }
  const lines = [...source.text.matchAll(/[^\n]+/g)]
    .map((match) => ({
      text: match[0].trim(),
      start: match.index,
      end: match.index + match[0].length,
    }))
    .filter((line) => line.text);
  const index = lines.findIndex((line) => line.start <= start && line.end > start);
  const current = lines[index];
  if (!current || current.text !== first.quote.trim()) return locationContext(claim);
  const before = lines[index - 1];
  const next = lines[index + 1];
  const after = lines[index + 2];
  let section = "";
  for (const line of lines.slice(0, index))
    if (
      /^(About|Experience|Education|Licenses & Certifications|Organizations|Courses|Languages)$/i.test(
        line.text,
      )
    )
      section = line.text.toLowerCase();
  let span: string | undefined;
  const revised = { ...claim };
  if (section === "licenses & certifications" && next && after && /^Issued\s/i.test(after.text)) {
    span = source.text.slice(current.start, after.end);
    revised.section = "recognition";
    revised.effectiveTo = claim.effectiveFrom;
    delete revised.fact;
  } else if (
    section === "education" &&
    current.text !== "-" &&
    !/^\d{4}\s*[-–]\s*\d{4}$/.test(current.text)
  ) {
    const dateIndex = next?.text === "-" ? index + 2 : index + 1;
    const dateLine = lines[dateIndex];
    const dates = dateLine && /^(\d{4})\s*[-–]\s*(\d{4})$/.exec(dateLine.text);
    if (dates) {
      const description = lines[dateIndex + 1];
      const end =
        description && /\b(programme?|school|degree|studies)\b/i.test(description.text)
          ? description.end
          : dateLine.end;
      span = source.text.slice(current.start, end);
      revised.section = "career";
      revised.effectiveFrom = dates[1]!;
      revised.effectiveTo = dates[2]!;
      delete revised.fact;
    }
  } else if (
    section === "organizations" &&
    before &&
    next &&
    before.text !== "Organizations" &&
    /\b\d{4}\s*[-–]\s*(?:Present|\w+\s+\d{4}|\d{4})/i.test(next.text)
  ) {
    span = source.text.slice(before.start, next.end);
    revised.section = "connections";
    delete revised.fact;
  }
  if (!span || span.length > 4000) return locationContext(claim);
  revised.statement = span
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== "-")
    .join(" — ");
  if (revised.statement.length > 4000) return claim;
  revised.citations = [{ ...first, quote: span }, ...claim.citations.slice(1)];
  return revised;
}

function locationContext(claim: PersonClaim): PersonClaim {
  // A comma-separated place fragment has no career predicate. Keep the
  // source wording in Current context instead of accepting it as background.
  if (
    claim.fact?.field === "background" &&
    !hasPredicate(claim.statement) &&
    /^[^,\n]+,[^,\n]+,[^,\n]+$/.test(claim.statement)
  ) {
    const revised = { ...claim, section: "context" as const };
    delete revised.fact;
    return revised;
  }
  return claim;
}

/** Preserve explicit structured entries even when a valid model reply omits
 * them. Only the subject's own LinkedIn page is eligible; these are retained
 * self-reports, never independently supported facts or inferred identities. */
export function recoverStructuredClaims(
  claims: PersonClaim[],
  source: PersonSourceDocument,
  profileUrls: string[],
  finalUrl: string,
): PersonClaim[] {
  const identity = (url: string) =>
    /^https?:\/\/(?:www\.)?linkedin\.com\/in\/([^/?#]+)\/?(?:[?#].*)?$/i
      .exec(url)?.[1]
      ?.toLowerCase();
  const subject = identity(source.url);
  if (
    !subject ||
    identity(finalUrl) !== subject ||
    !profileUrls.some((url) => identity(url) === subject)
  )
    return claims;
  const result = claims.map((claim) => retainClaimContext(claim, source));
  const lines = [...source.text.matchAll(/[^\n]+/g)]
    .map((match) => ({
      text: match[0].trim(),
      start: match.index,
      end: match.index + match[0].length,
    }))
    .filter((line) => line.text);
  const dated = (value: string): string | null => {
    const match = /^(?:([A-Za-z]+) )?(\d{4})$/.exec(value);
    if (!match) return null;
    if (!match[1]) return match[2]!;
    const months = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ];
    const month = months.indexOf(match[1].slice(0, 3).toLowerCase());
    return month < 0 ? null : `${match[2]}-${String(month + 1).padStart(2, "0")}`;
  };
  const append = (
    section: PersonClaim["section"],
    start: number,
    end: number,
    label: string,
    from: string | null,
    to: string | null,
  ) => {
    const quote = source.text.slice(start, end);
    if (
      quote.length > 4000 ||
      result.some((claim) => claim.citations.some((citation) => citation.quote.includes(quote)))
    )
      return;
    const statement = [
      label,
      ...quote
        .split("\n")
        .map((part) => part.trim())
        .filter((part) => part && part !== "-"),
    ].join(" — ");
    if (statement.length > 4000) return;
    result.push({
      id: `retained-${section}-${start}`,
      section,
      statement,
      status: "claimed",
      nature: "statement",
      matchConfidence: "high",
      effectiveFrom: from,
      effectiveTo: to,
      citations: [{ sourceId: source.id, quote }],
      supports: [],
      supersedes: [],
      changeReason:
        "Preserved explicit structured fields from the retained self-report; no independent verification.",
    });
  };
  let section = "";
  let sectionStart = 0;
  for (let index = 0; index < lines.length && result.length < 2000; index += 1) {
    const line = lines[index]!;
    if (
      /^(About|Experience|Education|Licenses & Certifications|Organizations|Courses|Languages|Recommendations|Interests)$/i.test(
        line.text,
      )
    ) {
      section = line.text.toLowerCase();
      sectionStart = index + 1;
      continue;
    }
    if (
      index >= sectionStart + 2 &&
      ["licenses & certifications", "organizations"].includes(section)
    ) {
      const title = lines[index - 2]!;
      const detail = lines[index - 1]!;
      if (title.text !== "-" && detail.text !== "-") {
        const issued = /^Issued (.+)$/.exec(line.text);
        const period = /^((?:[A-Za-z]+ )?\d{4})\s*[-–]\s*(Present|(?:[A-Za-z]+ )?\d{4})$/i.exec(
          line.text,
        );
        if (section === "licenses & certifications" && issued) {
          const date = dated(issued[1]!);
          append("recognition", title.start, line.end, "Credential issued", date, date);
        } else if (section === "organizations" && period) {
          append(
            "connections",
            title.start,
            line.end,
            "Organization",
            dated(period[1]!),
            dated(period[2]!),
          );
        }
      }
    }
    const dates = /^(\d{4})\s*[-–]\s*(\d{4})$/.exec(line.text);
    if (section !== "education" || !dates) continue;
    const candidate = index > sectionStart ? lines[index - 1] : undefined;
    const previous =
      candidate && !/^\d{4}\s*[-–]\s*\d{4}$/.test(candidate.text) ? candidate : undefined;
    // A '-' represents an absent field, not the previous entry's institution.
    // A leading institution may precede that empty field; later ambiguous
    // entries retain their dates with the institution explicitly unknown.
    const institution =
      previous?.text === "-"
        ? index === sectionStart + 2
          ? lines[sectionStart]
          : undefined
        : previous;
    const description = lines[index + 1];
    const end =
      description && /\b(programme?|school|degree|studies)\b/i.test(description.text)
        ? description.end
        : line.end;
    const start = institution?.start ?? line.start;
    append(
      "career",
      start,
      end,
      institution ? "Education" : "Education — Institution unknown",
      dates[1]!,
      dates[2]!,
    );
  }
  return result;
}
