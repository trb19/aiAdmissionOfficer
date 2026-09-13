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
    model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
  },

  sheets: {
    spreadsheetId: required("GOOGLE_SHEETS_SPREADSHEET_ID"),
    tabName: process.env.GOOGLE_SHEETS_TAB_NAME ?? "Admission Queries",
    serviceAccountKeyPath:
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ?? "./service-account.json",
  },

  escalationPhone: process.env.ESCALATION_PHONE ?? "6001819309",
};
