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
    const now = formatIstDateTime(new Date());
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

// --- CRM lead tracker -------------------------------------------------------------------------
// GLO's staff already run their admissions pipeline out of a "CRM" tab (Lead ID, Date of Inquiry,
// Child Name, Class Interested, Parent Name, Phone, Age, Status, Last Contact Date, Next
// Follow-up Date, Source, Remarks, Address) fed by phone calls, school visits, and ad leads
// (Insta/Facebook Ads). Confirmed with Tirth 14 Sept 2026: a WhatsApp enquiry should land in that
// same tab (Source "Whatsapp") rather than a bot-only sheet, so staff have one place to see every
// lead regardless of how it came in.
const CRM_TAB_NAME = "CRM";
const CRM_HEADER = [
  "Lead ID",
  "Date of Inquiry",
  "Child Name",
  "Class Interested",
  "Parent Name",
  "Phone",
  "Age",
  "Status",
  "Last Contact Date",
  "Next Follow-up Date",
  "Source",
  "Remarks",
  "Address",
];

/** Matches the sheet's own "14-Sep-2026" style dates, in IST (the school's timezone) rather than
 * whatever timezone the server happens to run in. */
export function formatCrmDate(d: Date): string {
  return d
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
    .replace(/ /g, "-");
}

/** Full date + time in IST, for the columns that need a timestamp rather than just a day (the
 * Conversations tab's "Last Updated", the enquiry log's "Timestamp"). Staff read these sheets
 * sitting in Tezpur, not UTC - a raw `.toISOString()` timestamp reads several hours off from what
 * actually happened locally, which is exactly the kind of thing that quietly misleads someone
 * checking "did we reply to this parent this morning or last night". Built on formatCrmDate so the
 * date portion matches the rest of the sheet exactly. */
export function formatIstDateTime(d: Date): string {
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
  return `${formatCrmDate(d)} ${time}`;
}

/** Existing CRM rows use plain digit strings in all sorts of shapes (with/without +91, spaces).
 * Comparing by the last 10 digits matches a WhatsApp lead against a staff-entered phone-call or
 * visit row for the same family without needing every source to agree on formatting. */
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

export interface CrmLeadUpdate {
  phone: string;
  parentName?: string;
  childName?: string;
  childAge?: string;
  /** Plain-English running summary of the WhatsApp conversation so far (same text that goes into
   * the "Conversations" tab). Confirmed with Tirth 15 Sept 2026: Remarks is meant to be kept fresh
   * by the bot so staff can see what's been discussed without opening the Conversations tab.
   * Refined 15 Sept 2026: one dated line per CALENDAR DAY (IST) rather than one line per message -
   * "15-Sep-2026: <summary>" - so Remarks reads as a day-by-day log of the relationship (phone/
   * visit notes staff add by hand included) instead of a per-message transcript. Every message that
   * arrives on the same day rewrites that day's line in place with the freshest whole-conversation
   * summary; a message on a new day adds a new line below it, leaving the previous day's line as
   * it was. That's what actually helps staff screen a caller quickly. */
  remarks?: string;
}

/** Folds a new summary into Remarks as one line per calendar day - see the CrmLeadUpdate.remarks
 * doc for why. If the LAST line already belongs to `today`, it's replaced with the fresh summary
 * (same day, conversation moved on); otherwise a new dated line is appended below whatever's
 * already there, so an earlier day's line - or a staff-typed note with no date prefix at all -
 * is left untouched. No-op when there's no new remark to add. */
function appendRemark(existing: string, today: string, remark: string | undefined): string {
  if (!remark) return existing;
  const entry = `${today}: ${remark}`;
  if (!existing) return entry;

  const lines = existing.split("\n");
  if (lines[lines.length - 1].startsWith(`${today}: `)) {
    lines[lines.length - 1] = entry;
    return lines.join("\n");
  }
  return `${existing}\n${entry}`;
}

/** Adds or updates one row per family in the shared "CRM" tab, keyed by phone number - one lead,
 * one row, no matter whether it started as a phone call, a school visit, an ad click, or (now) a
 * WhatsApp message. Deliberately non-destructive: Status, Next Follow-up Date, Address, and Class
 * Interested are staff-owned fields this never overwrites, only fills in when still blank, so it's
 * safe to call on every inbound message without undoing a staff member's follow-up work. Remarks is
 * the one exception - each new conversation summary is appended to it as its own dated line rather
 * than overwriting what's there (see the CrmLeadUpdate.remarks / appendRemark docs), so staff-typed
 * notes are preserved too. A brand-new lead gets Status "Open" (matching the convention already
 * used for fresh/unqualified rows in this sheet) and the next sequential Lead ID. Last Contact Date
 * is always refreshed too, since that's the whole point of logging a new touchpoint.
 *
 * Note: Lead ID assignment reads the sheet's current max ID and adds one, so two brand-new leads
 * arriving in the same instant could in theory grab the same ID - an acceptable risk at Phase 0's
 * traffic, not something worth a locking scheme yet. */
export async function upsertCrmLead(update: CrmLeadUpdate): Promise<void> {
  try {
    const sheets = await getSheetsClient();
    await ensureTab(sheets, CRM_TAB_NAME, CRM_HEADER);

    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${CRM_TAB_NAME}!A2:M`,
    });
    const rows = data.values ?? [];
    const target = normalizePhone(update.phone);

    let maxLeadId = 0;
    let matchIndex = -1;
    rows.forEach((row, i) => {
      const idNum = Number(row[0]);
      if (Number.isFinite(idNum) && idNum > maxLeadId) maxLeadId = idNum;
      if (matchIndex === -1 && target.length === 10 && normalizePhone(row[5] ?? "") === target) {
        matchIndex = i;
      }
    });

    const today = formatCrmDate(new Date());
    const cell = (row: string[], i: number) => row[i] ?? "";

    if (matchIndex === -1) {
      const row = [
        String(maxLeadId + 1),
        today,
        update.childName ?? "",
        "",
        update.parentName ?? "",
        update.phone,
        update.childAge ?? "",
        "Open",
        today,
        "",
        "Whatsapp",
        appendRemark("", today, update.remarks),
        "",
      ];
      await sheets.spreadsheets.values.append({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${CRM_TAB_NAME}!A:M`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
      });
    } else {
      const existing = rows[matchIndex];
      const sheetRow = matchIndex + 2; // +1 for header, +1 to go from 0-based to 1-based
      const row = [
        cell(existing, 0) || String(maxLeadId + 1),
        cell(existing, 1) || today,
        cell(existing, 2) || (update.childName ?? ""),
        cell(existing, 3),
        cell(existing, 4) || (update.parentName ?? ""),
        update.phone,
        cell(existing, 6) || (update.childAge ?? ""),
        cell(existing, 7) || "Open",
        today,
        cell(existing, 9),
        cell(existing, 10) || "Whatsapp",
        appendRemark(cell(existing, 11), today, update.remarks),
        cell(existing, 12),
      ];
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${CRM_TAB_NAME}!A${sheetRow}:M${sheetRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
      });
    }
  } catch (err) {
    // Same rule as logEnquiry: never let a Sheets hiccup break a parent's reply.
    console.error("Failed to upsert CRM lead in Google Sheets:", err);
  }
}
