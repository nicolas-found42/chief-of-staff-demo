import type { PersonDossierContent, PersonSourceDocument } from "@chief-of-staff-demo/shared";

/** Only the public profile's attributed article section, never activity or suggestions. */
export function linkedInProfileText(document: Document, url: string): string {
  if (!/^https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\/[^/]+\/?(?:[?#].*)?$/i.test(url)) return "";
  const section = document.querySelector('section[data-section="articles"]');
  const heading = section?.querySelector("h2")?.textContent.trim();
  const author = document.querySelector("h1")?.textContent.trim().replace(/\s+/g, " ");
  if (!author) return "";
  const identity = `Public profile name: ${author}`;
  if (!section || !heading?.startsWith("Articles by ")) return identity;
  const records = new Map<string, string>();
  for (const card of section.querySelectorAll(".main-article-card")) {
    const title = card.querySelector("h3")?.textContent.trim().replace(/\s+/g, " ");
    const link = card.querySelector('a[href*="/pulse/"]')?.getAttribute("href");
    const date = card.querySelector(".base-main-card__metadata-item")?.textContent.trim();
    if (!title || !link || !date || title.length > 1000) continue;
    let target: URL;
    try {
      target = new URL(link, url);
    } catch {
      continue;
    }
    if (
      !/^https?:$/.test(target.protocol) ||
      !/(^|\.)linkedin\.com$/i.test(target.hostname) ||
      !target.pathname.startsWith("/pulse/")
    )
      continue;
    target.search = "";
    target.hash = "";
    records.set(
      target.href,
      `Article listed by ${author}\nTitle: ${title}\nDate: ${date}\nURL: ${target.href}`,
    );
    if (records.size === 20) break;
  }
  return records.size
    ? `${identity}\n\nPublic profile article metadata (self-report; article contents not retrieved):\n${[...records.values()].join("\n\n")}`
    : `${identity}\n\nArticle capture limitation: this public profile has an Articles by section but no readable attributed article cards were captured. Article availability is unknown.`;
}

/** Recovery after valid extraction, only for the identity-matched subject's own page. */
export function retainLinkedInArticles(
  content: PersonDossierContent,
  source: PersonSourceDocument,
  profileUrls: string[],
  finalUrl: string,
): PersonDossierContent {
  const identity = (url: string) =>
    /^https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\/([^/?#]+)\/?(?:[?#].*)?$/i
      .exec(url)?.[1]
      ?.toLowerCase();
  const subject = identity(source.url);
  if (
    !subject ||
    identity(finalUrl) !== subject ||
    !profileUrls.some((url) => identity(url) === subject)
  )
    return content;
  const claims = [...content.claims];
  const works = [...content.works];
  const name = linkedInProfileName(source, profileUrls, finalUrl);
  if (
    name &&
    !claims.some((claim) => claim.fact?.field === "fullName" && claim.fact.value === name)
  )
    claims.unshift({
      id: "public-profile-name",
      section: "overview",
      statement: `The public profile lists the name ${name}.`,
      fact: { field: "fullName", value: name },
      status: "claimed",
      nature: "statement",
      matchConfidence: "high",
      effectiveFrom: null,
      effectiveTo: null,
      citations: [{ sourceId: source.id, quote: `Public profile name: ${name}` }],
      supports: [],
      supersedes: [],
      changeReason:
        "Name attributed to the matched public profile heading; no independent verification.",
    });
  for (const match of source.text.matchAll(
    /^Article listed by (.+)\nTitle: (.+)\nDate: (.+)\nURL: (https?:\/\/[^\s]+)$/gm,
  )) {
    const [, author, title, rawDate, url] = match;
    // Captured metadata is authoritative for this record's identity and dates.
    // A model-created record may cite an unrelated claim or invent article contents.
    const existing = works.findIndex((work) => work.url === url);
    const existingId = existing >= 0 ? works[existing]!.id : undefined;
    if (existing >= 0) works.splice(existing, 1);
    const parsed = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})$/.exec(
      rawDate!,
    );
    const date = parsed
      ? `${parsed[3]}-${String(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(parsed[1]!) + 1).padStart(2, "0")}-${parsed[2]!.padStart(2, "0")}`
      : null;
    const id = `article-${match.index}`;
    claims.push({
      id,
      section: "ideas",
      statement: `${author}'s public profile lists the article “${title}” (${rawDate}). Article contents have not been verified.`,
      status: "claimed",
      nature: "statement",
      matchConfidence: "high",
      effectiveFrom: date,
      effectiveTo: date,
      citations: [{ sourceId: source.id, quote: match[0] }],
      supports: [],
      supersedes: [],
      changeReason:
        "Public profile attribution is self-report; only title, date, author attribution and URL are retained.",
    });
    works.push({
      id: existingId ?? id,
      title: title!,
      url: url!,
      kind: "post",
      startedAt: date,
      endedAt: date,
      claimIds: [id],
      contribution: null,
      teamContribution: null,
      authority: [],
      scale: [],
      constraints: [],
      outcomes: [],
    });
  }
  return { ...content, claims, works };
}

export function linkedInProfileName(
  source: PersonSourceDocument,
  profileUrls: string[],
  finalUrl: string,
): string | null {
  const identity = (url: string) =>
    /^https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\/([^/?#]+)\/?(?:[?#].*)?$/i
      .exec(url)?.[1]
      ?.toLowerCase();
  const subject = identity(source.url);
  if (
    !subject ||
    identity(finalUrl) !== subject ||
    !profileUrls.some((url) => identity(url) === subject)
  )
    return null;
  return /^Public profile name: ([^\n]{1,200})$/m.exec(source.text)?.[1] ?? null;
}
