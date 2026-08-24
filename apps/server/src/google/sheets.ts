import { google } from "googleapis";
import type { GoogleAuth } from "./oauth.js";

/**
 * The Sheets Output Adapter: a set of functions over one Google surface, beside
 * Tasks and Gmail, not a class anybody implements. Append only — this app adds
 * a day's rows and never rewrites yesterday's, so the row-update step the Relay
 * original had does not survive into this design at all.
 *
 * The writes need no new scope: the full Drive scope this app already holds
 * after ADR-0021 authorizes creating a spreadsheet and writing values, so the
 * only consent this Module costs is the YouTube one.
 */
export interface CreatedSpreadsheet {
  id: string;
  /** Google's own link to the file, returned by the create call. */
  url: string;
}

export async function createSpreadsheet(
  auth: GoogleAuth,
  title: string,
): Promise<CreatedSpreadsheet> {
  const sheets = google.sheets({ version: "v4", auth });
  const created = await sheets.spreadsheets.create({
    requestBody: { properties: { title } },
    fields: "spreadsheetId,spreadsheetUrl",
  });
  const id = created.data.spreadsheetId;
  if (!id) {
    throw new Error("Google created no spreadsheet");
  }
  /* The file lands in the root of the operator's Drive: a parent folder cannot
     be named on this call, and moving it afterwards is not worth a second
     round trip for a file they can drag wherever they like. */
  return { id, url: created.data.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${id}` };
}

/** The tabs a spreadsheet has, by title. Throws if the spreadsheet is gone. */
async function tabTitles(auth: GoogleAuth, spreadsheetId: string): Promise<string[]> {
  const sheets = google.sheets({ version: "v4", auth });
  const found = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });
  return (found.data.sheets ?? [])
    .map((sheet) => sheet.properties?.title)
    .filter((title): title is string => typeof title === "string");
}

/** Add a tab with its header row. Does nothing if a tab of that name is there. */
export async function ensureTab(
  auth: GoogleAuth,
  spreadsheetId: string,
  title: string,
  header: string[],
): Promise<void> {
  if ((await tabTitles(auth, spreadsheetId)).includes(title)) {
    return;
  }
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  await appendRows(auth, spreadsheetId, title, [header]);
}

/** Ensure the tab exists and its header contains ContentType beside Format (idempotent migration). */
export async function ensureTabWithMigration(
  auth: GoogleAuth,
  spreadsheetId: string,
  title: string,
  header: string[],
): Promise<void> {
  const exists = (await tabTitles(auth, spreadsheetId)).includes(title);
  if (!exists) {
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
    await appendRowsWithUserEntered(auth, spreadsheetId, title, [header]);
    return;
  }
  // Tab exists: check header row for ContentType migration
  try {
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${title.replace(/'/g, "''")}'!1:1`,
    });
    const row = (res.data.values?.[0] as string[] | undefined) ?? [];
    const hasContentType = row.includes("ContentType");
    const hasFormat = row.includes("Format");
    if (hasFormat && !hasContentType) {
      // Migrate once: rewrite header to new shape; old rows keep blank for new column, new rows fill it.
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${title.replace(/'/g, "''")}'!1:1`,
        valueInputOption: "RAW",
        requestBody: { values: [header] },
      });
    }
  } catch {
    // If header check fails, fall back to no-op; append will still work but ContentType may be blank.
  }
}

/**
 * Append rows to the bottom of one tab. One call per tab rather than a batched
 * multi-range write: Google documents no maximum number of ranges for the
 * batched form, and an undocumented limit is not a limit to build on.
 */
export async function appendRows(
  auth: GoogleAuth,
  spreadsheetId: string,
  tab: string,
  rows: (string | number)[][],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    /* Quoted, because a tab named for a channel may contain spaces. */
    range: `'${tab.replace(/'/g, "''")}'!A:D`,
    valueInputOption: "RAW",
    /* INSERT_ROWS, not OVERWRITE: appending must never land on a row somebody
       added by hand underneath. */
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

/** Variant for Idea Engine: USER_ENTERED so dates/URLs are parsed as the user would type them. */
export async function appendRowsWithUserEntered(
  auth: GoogleAuth,
  spreadsheetId: string,
  tab: string,
  rows: (string | number)[][],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tab.replace(/'/g, "''")}'!A:K`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

/**
 * Google's answer when the spreadsheet is not there any more. Named so a Run can
 * fail loudly and point at the action that creates one, instead of quietly
 * creating a second: two spreadsheets and no way to tell which is live is a
 * worse failure than a red Run.
 */
export function isSpreadsheetMissing(error: unknown): boolean {
  const raw = error as { code?: number; status?: number; response?: { status?: number } };
  const status = raw.code ?? raw.status ?? raw.response?.status;
  if (status === 404) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /Requested entity was not found|notFound/i.test(message);
}
