import type { PersonProfile } from "@chief-of-staff-demo/shared";

/** Exact source slices, with offsets into the retained original for review/expansion. */
export function extractionPassages(text: string, profile: PersonProfile) {
  const size = text.length > 60000 ? 15000 : 16000;
  const passages = [];
  const signals = [
    profile.fullName,
    ...profile.emails,
    profile.currentEmployer,
    ...profile.employerHints,
  ]
    .filter((value): value is string => !!value?.trim())
    .map((value) => value.toLowerCase());
  for (let offset = 0; offset < text.length; offset += size) {
    const value = text.slice(offset, offset + size);
    const folded = value.toLowerCase();
    passages.push({
      text: value,
      offset,
      score: signals.filter((signal) => folded.includes(signal)).length,
    });
  }
  if (text.length <= 60000) return passages;
  // Keep opening context and rank the rest. Equal scores retain source order.
  // Never concatenate disjoint excerpts into an invented continuous passage.
  return [
    passages[0]!,
    ...passages
      .slice(1)
      .sort((a, b) => b.score - a.score || a.offset - b.offset)
      .slice(0, 3),
  ].sort((a, b) => a.offset - b.offset);
}
