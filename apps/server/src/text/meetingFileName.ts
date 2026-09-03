export interface MeetingFileNameMeta {
  /**
   * The human title the name carries — the stem with any timestamp removed.
   * Null when the remainder is empty or carries no words at all.
   */
  title: string | null;
  /**
   * The full timestamp the name carries, as ISO (midnight UTC when the name
   * carries only a date), or null when it carries none.
   */
  timestamp: string | null;
}

/** Fireflies exports embed the whole UTC timestamp (`…-2026-06-18T13-00-00.000Z`). */
const EMBEDDED_TIMESTAMP = /(\d{4}-\d{2}-\d{2})T(\d{2})[-:](\d{2})(?:[-:]\d{2}(?:\.\d+)?Z?)?/;
const LEADING = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2})[-.](\d{2})(?:[-.](\d{2}))?)?\s*[-_ ]*(.*)$/;
const TRAILING =
  /^(.*?)[-_ ]*\(?(\d{4}-\d{2}-\d{2})(?:[T ](\d{2})[-.](\d{2})(?:[-.](\d{2}))?)?\)?$/;

function titleOf(raw: string): string | null {
  const title = raw.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return /[a-z]/i.test(title) ? title : null;
}

function timestampOf(date: string, hours?: string | null, minutes?: string | null): string {
  if (hours === undefined || hours === null || minutes === undefined || minutes === null) {
    return `${date}T00:00:00.000Z`;
  }
  return `${date}T${hours}:${minutes}:00.000Z`;
}

/**
 * Recover what a transcript's file name says about the meeting it recorded
 * (issue #153): its title and, when present, the full timestamp.
 *
 * A neutral text helper (issue #142): the Transcript Catalog reads these
 * names, and now the Meeting matching reads them too, so the vocabulary stays
 * in one place rather than inside either consumer.
 */
export function meetingFileNameMeta(fileName: string): MeetingFileNameMeta {
  const stem = fileName.replace(/\.[a-z0-9]+$/i, "");

  const embedded = EMBEDDED_TIMESTAMP.exec(stem);
  if (embedded) {
    return {
      title: titleOf(stem.replace(EMBEDDED_TIMESTAMP, " ")),
      timestamp: timestampOf(embedded[1]!, embedded[2], embedded[3]),
    };
  }

  const leading = LEADING.exec(stem);
  if (leading) {
    return {
      title: titleOf(leading[5] ?? ""),
      timestamp: timestampOf(leading[1]!, leading[2], leading[3]),
    };
  }

  const trailing = TRAILING.exec(stem);
  if (trailing) {
    return {
      title: titleOf(trailing[1] ?? ""),
      timestamp: timestampOf(trailing[2]!, trailing[3], trailing[4]),
    };
  }

  return { title: titleOf(stem), timestamp: null };
}
