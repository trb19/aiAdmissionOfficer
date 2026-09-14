import { google } from "googleapis";
import { config } from "./config.js";

let sheetsClientPromise: ReturnType<typeof buildClient> | null = null;

async function buildClient() {
  // Prefer the JSON-in-env-var form (Render free tier has no persistent disk to put a
  // service-account.json file on); fall back to a key file for local development.
  const authOptions = config.sheets.serviceAccountKeyJson
    ? { credentials: JSON.parse(config.sheets.serviceAccountKeyJson) }
    : { keyFile: config.sheets.serviceAccountKeyPath };

  const auth = new google.auth.GoogleAuth({
    ...authOptions,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function getSheetsClient() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = buildClient();
  }
  return sheetsClientPromise;
}

/** Ensures a tab with the given name exists in the spreadsheet, creating it with a header row if
 * not. Sheets throws if you try to read/write a range on a tab that doesn't exist yet, so both the
 * enquiry log and the conversation-summary tab call this lazily rather than assuming staff (or a
 * newly swapped-in spreadsheet) already has the right tabs set up. Cheap no-op once the tab exists
 * - one metadata call per process, not per write. */
const knownTabs = new Set<string>();

async function ensureTab(
  sheets: Awaited<ReturnType<typeof buildClient>>,
  tabName: string,
  header: string[]
): Promise<void> {
  if (knownTabs.has(tabName)) return;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.spreadsheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheets.spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tabName } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${tabName}!A1:${String.fromCharCode(64 + header.length)}1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [header] },
    });
  }

  knownTabs.add(tabName);
}

export interface EnquiryLogRow {
  timestamp: string;
  phone: string;
  question: string;
  aiAnswer: string;
  classification: string;
}

const ENQUIRY_HEADER = ["Timestamp", "Name", "Phone", "Question", "AI Answer", "Classification"];

/** Appends one row to the enquiry log tab (self-created with a header row on first use, so
 * pointing the bot at a fresh spreadsheet doesn't require manually pre-making tabs). Name is left
 * blank since Phase 0 doesn't collect it, and a Classification column is added at the end
 * (FEE_QUESTION / HUMAN_REQUEST / ROUTINE) so staff can filter for the calls-and-handoffs that
 * need a human follow-up. */
export async function logEnquiry(row: EnquiryLogRow): Promise<void> {
  try {
    const sheets = await getSheetsClient();
    await ensureTab(sheets, config.sheets.tabName, ENQUIRY_HEADER);
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${config.sheets.tabName}!A:F`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[row.timestamp, "", row.phone, row.question, row.aiAnswer, row.classification]],
      },
    });
  } catch (err) {
    // Logging failure should never take down the reply path - a parent still gets an answer even
    // if the sheet is temporarily unreachable. Surface it loudly in the server logs instead, since
    // a silent logging failure is exactly the kind of thing that goes unnoticed for weeks.
    console.error("Failed to log enquiry to Google Sheets:", err);
  }
}

const CONVERSATIONS_HEADER = ["Phone", "Last Updated", "Summary", "Last Classification"];

/** Finds the existing row for this phone number in the "Conversations" tab, or -1 if there isn't
 * one yet. Returns a 0-based data row index (excluding the header row). */
async function findConversationRow(
  sheets: Awaited<ReturnType<typeof buildClient>>,
  phone: string
): Promise<number> {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.conversationsTabName}!A2:A`,
  });
  const rows = data.values ?? [];
  return rows.findIndex((r) => r[0] === phone);
}

/** Keeps one row per parent phone number in the "Conversations" tab, holding a running plain-
 * English summary of the whole chat so far rather than a per-message log - the enquiry log tab
 * already has every individual Q&A; this is the quick-glance view staff asked for. Updates the
 * existing row in place if one exists, otherwise appends a new one. */
export async function upsertConversationSummary(
  phone: string,
  summary: string,
  lastClassification: string
): Promise<void> {
  try {
    const sheets = await getSheetsClient();
    await ensureTab(sheets, config.sheets.conversationsTabName, CONVERSATIONS_HEADER);

    const rowIndex = await findConversationRow(sheets, phone);
    const now = new Date().toISOString();
    const values = [[phone, now, summary, lastClassification]];

    if (rowIndex === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${config.sheets.conversationsTabName}!A:D`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values },
      });
    } else {
      const sheetRow = rowIndex + 2; // +1 for header, +1 for 0-based -> 1-based
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${config.sheets.conversationsTabName}!A${sheetRow}:D${sheetRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values },
      });
    }
  } catch (err) {
    // Same rule as logEnquiry: never let a Sheets hiccup break a parent's reply.
    console.error("Failed to update conversation summary in Google Sheets:", err);
  }
}
