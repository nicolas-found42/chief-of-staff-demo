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
  /**
   * Whether that timestamp states a time of day, or only a date. A name that
   * states a time is naming the meeting's own start; one that states only a
   * date can claim no more than the day, and its midnight is padding rather
   * than evidence. Readers that compare it to a Meeting's start need to know
   * which they have.
   */
  namesTime: boolean;
}

/** Fireflies exports embed the whole UTC timestamp (`…-2026-06-18T13-00-00.000Z`). */
const EMBEDDED_TIMESTAMP = /(\d{4}-\d{2}-\d{2})T(\d{2})[-:](\d{2})(?:[-:]\d{2}(?:\.\d+)?Z?)?/;
const LEADING = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2})[-.](\d{2})(?:[-.](\d{2}))?)?\s*[-_ ]*(.*)$/;
const TRAILING =
  /^(.*?)[-_ ]*\(?(\d{4}-\d{2}-\d{2})(?:[T ](\d{2})[-.](\d{2})(?:[-.](\d{2}))?)?\)?$/;

/**
 * Words a transcript exporter appends to name the artifact rather than the
 * meeting — "…-transcript-2026-09-01T12-00-00.000Z". Left in, they become part
 * of the Meeting's title and every stand-up in the folder ends up named
 * "Found42 Stand Up Meeting transcript", indistinguishable from the next.
 *
 * Only stripped from a name that also carries a timestamp, because that is the
 * exporter's shape. A plainly-named "Team Sync notes.txt" keeps its word: a
 * meeting really can be called "Design Notes", and this must not rename it.
 */
const ARTIFACT_TAIL =
  /[\s-]+(?:transcripts?|summary|summaries|notes?|recordings?|audio|video|minutes)$/i;
/** Drive's duplication prefix, repeated once per copy of a copy. */
const COPY_PREFIX = /^(?:copy\s+of\s+)+/i;

function titleOf(raw: string, exporterNamed = false): string | null {
  const spaced = raw.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  /* Drive's copy prefix goes either way: it is never part of a meeting's name. */
  let title = spaced.replace(COPY_PREFIX, "").trim();
  if (exporterNamed) {
    /* Strip repeatedly: "… summary notes" carries two, and one pass would
       leave the outer one behind. Never strip the whole title away — a file
       genuinely called "Transcript" keeps the only name it has. */
    for (;;) {
      const next = title.replace(ARTIFACT_TAIL, "").trim();
      if (next === title || next === "") break;
      title = next;
    }
  }
  if (title === "") title = spaced;
  return /[a-z]/i.test(title) ? title : null;
}

/** Whether the name's timestamp carried an hour and a minute of its own. */
function statesTime(hours?: string | null, minutes?: string | null): boolean {
  return typeof hours === "string" && typeof minutes === "string";
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
      title: titleOf(stem.replace(EMBEDDED_TIMESTAMP, " "), true),
      timestamp: timestampOf(embedded[1]!, embedded[2], embedded[3]),
      namesTime: statesTime(embedded[2], embedded[3]),
    };
  }

  const leading = LEADING.exec(stem);
  if (leading) {
    return {
      title: titleOf(leading[5] ?? "", true),
      timestamp: timestampOf(leading[1]!, leading[2], leading[3]),
      namesTime: statesTime(leading[2], leading[3]),
    };
  }

  const trailing = TRAILING.exec(stem);
  if (trailing) {
    return {
      title: titleOf(trailing[1] ?? "", true),
      timestamp: timestampOf(trailing[2]!, trailing[3], trailing[4]),
      namesTime: statesTime(trailing[3], trailing[4]),
    };
  }

  return { title: titleOf(stem), timestamp: null, namesTime: false };
}
