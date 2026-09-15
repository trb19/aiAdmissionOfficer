import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),

  whatsapp: {
    token: required("WHATSAPP_TOKEN"),
    phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0",
    verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
  },

  gemini: {
    apiKey: required("GEMINI_API_KEY"),
        model: process.env.GEMINI_MODEL ?? "gemini-3.6-flash",
  },

  sheets: {
    spreadsheetId: required("GOOGLE_SHEETS_SPREADSHEET_ID"),
    tabName: process.env.GOOGLE_SHEETS_TAB_NAME ?? "Admission Queries",
    conversationsTabName: process.env.GOOGLE_SHEETS_CONVERSATIONS_TAB_NAME ?? "Conversations",
    // Two ways to supply the service-account credential: a file path (handy for local dev, where
    // dropping a service-account.json next to the code is easy) or the key's JSON contents
    // directly in an env var (needed on hosts like Render's free tier with no persistent disk to
    // upload a file onto). If both are set, the env var wins since it's the production path.
    serviceAccountKeyPath:
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ?? "./service-account.json",
    serviceAccountKeyJson: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON,
  },

  // Postgres connection string for durable conversation memory (see src/db.ts). Render's free
  // Postgres tier works fine for Phase 0's volume - create one in the Render dashboard and paste
  // its "Internal Database URL" here.
  database: {
    url: required("DATABASE_URL"),
  },

  escalationPhone: process.env.ESCALATION_PHONE ?? "6001819309",

  // Shared secret the CRM's "Send WhatsApp" button must present (as an `x-api-key` header) to hit
  // POST /send-template below - that endpoint can push a message to a parent OUTSIDE the normal
  // 24-hour reply window (see sendWhatsAppTemplate in whatsapp.ts for why that needs an
  // Meta-approved template), so it's not left wide open the way /webhook is. Optional on purpose:
  // if it's not set on Render yet, the endpoint still works (logs a warning) so Tirth can test the
  // plumbing today with the "hello_world" sample template before generating and setting a real
  // secret. Set CRM_SEND_SECRET on Render (any random string) once ready to lock it down.
  crm: {
    sendSecret: process.env.CRM_SEND_SECRET,
  },
};
