import type { PersonProfile } from "@chief-of-staff-demo/shared";

/**
 * Whether one extracted claim is about the person it is being filed under.
 *
 * Identity is decided for a whole document (`decideIdentity`), and grounding
 * is checked for a whole claim (`parsePartial`): a document that mentions the
 * subject once and otherwise describes a different named individual passes
 * both, and its claims about that other individual publish with verbatim
 * citations (#409). Grounding is not the question being asked.
 *
 * Two layers, because a per-claim name test alone would cost recall: a
 * document that really is about the subject describes them pronominally
 * ("he was appointed"), and those claims must still publish. So the strict
 * per-claim test runs only against a document that declares a different
 * individual as its own subject.
 */

const foldName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The individual a document declares as its own subject, folded, or null.
 *
 * Read from the first declaration in the document's opening — the shape an
 * encyclopedic or biographical page states its subject in ("Sherrie Silver is
 * a Rwandan-born British choreographer"). It is looked for at the start of a
 * line anywhere in that opening rather than at the very start of the text: a
 * retained article carries a lead-in and an infobox before its first sentence
 * ("From Wikipedia, the free encyclopedia", then the box), and the retained
 * evidence this was measured against puts the declaration 251 characters in.
 *
 * The title alone is not enough: a title is often a site name, a headline or
 * a section, and reading a subject out of one would close the gate on
 * documents that are about the subject after all.
 */
const OPENING = 1500;
const DECLARATION =
  /^[^\S\n]*([\p{Lu}][\p{L}'’.-]*(?:\s+[\p{Lu}][\p{L}'’.-]*){0,4})\s+(?:is|was|has|had)\s/mu;

function declaredSubject(text: string): string | null {
  const opening = DECLARATION.exec(text.slice(0, OPENING));
  return opening?.[1] ? foldName(opening[1]) : null;
}

/** Every name the subject may be referred to by in running text. */
function subjectNames(profile: PersonProfile): string[] {
  const full = profile.fullName ? foldName(profile.fullName) : null;
  if (!full) return [];
  const tokens = full.split(" ");
  /* The family name alone is how running prose refers back to a person. It
     admits a claim rather than refusing one, so a common surname costs
     nothing a whole-name test would have caught. */
  const surname = tokens.length > 1 ? tokens[tokens.length - 1]! : null;
  return surname && surname.length >= 3 ? [full, surname] : [full];
}

/**
 * Whether this document declares an individual other than the subject as what
 * it is about. Only such a document gets the per-claim test below.
 */
export function declaresOtherSubject(text: string, profile: PersonProfile): boolean {
  const declared = declaredSubject(text);
  if (!declared) return false;
  return !subjectNames(profile).some(
    (name) => declared === name || declared.includes(name) || name.includes(declared),
  );
}

/** The sentence of `text` that carries `quote`, or the quote itself. */
function sentenceAround(text: string, quote: string): string {
  const at = text.indexOf(quote);
  if (at < 0) return quote;
  const start = Math.max(...[".", "!", "?"].map((mark) => text.lastIndexOf(mark, at)), -1) + 1;
  /* From the quote's last character, so a quote that already ends in a full
     stop ends the window there rather than absorbing the sentence after it. */
  const ends = [".", "!", "?"]
    .map((mark) => text.indexOf(mark, at + quote.length - 1))
    .filter((index) => index >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) + 1 : text.length);
}

/**
 * Whether a claim cited from a document about someone else still concerns the
 * subject: its cited passage, in the sentence it sits in, names them.
 */
export function claimNamesSubject(
  claim: { citations: { quote: string }[] },
  text: string,
  profile: PersonProfile,
): boolean {
  const names = subjectNames(profile);
  if (names.length === 0) return false;
  return claim.citations.some((citation) => {
    const folded = foldName(sentenceAround(text, citation.quote));
    return names.some((name) => folded.includes(name));
  });
}
