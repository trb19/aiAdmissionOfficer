import { google } from "googleapis";
import { config } from "./config.js";

let sheetsClientPromise: ReturnType<typeof buildClient> | null = null;

async function buildClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.sheets.serviceAccountKeyPath,
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

export interface EnquiryLogRow {
  timestamp: string;
  phone: string;
  question: string;
  aiAnswer: string;
  classification: string;
}

/** Appends one row to the existing "Admission Queries" tab. Matches the existing sheet's columns
 * (Timestamp, Name, Phone, Question, AI Answer) - Name is left blank since Phase 0 doesn't collect
 * it, and a Classification column is added at the end (FEE_QUESTION / HUMAN_REQUEST / ROUTINE) so
 * staff can filter for the calls-and-handoffs that need a human follow-up. */
export async function logEnquiry(row: EnquiryLogRow): Promise<void> {
  try {
    const sheets = await getSheetsClient();
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
