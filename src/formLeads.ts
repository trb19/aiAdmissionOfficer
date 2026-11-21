/**
 * Website enquiry forms (Elementor "Webhook" action) and Google Ads lead forms post here instead
 * of to the CRM web app: the CRM is only reachable by signed-in Google users, while this bot is
 * public. Both senders must present a shared key (FORM_WEBHOOK_KEY / GOOGLE_LEAD_KEY on Render,
 * the same values as the CRM's Script Properties).
 *
 * The parsing rules match crm/Code.gs (parseWebsiteForm_ / parseGoogleLead_) so a lead looks the
 * same whichever door it came through.
 */

export interface FormLead {
  /** Shown in the CRM note, e.g. "Website form" or "Google Ads lead form". */
  kind: string;
  /** CRM Source column for a new lead. */
  source: "Website" | "Google Ads";
  parentName: string;
  childName: string;
  childAge: string;
  phone: string;
  email: string;
  area: string;
  message: string;
  honeypot: string;
  /** Form name or campaign, for the note. */
  page: string;
  isTest: boolean;
}

type FormBody = Record<string, unknown>;

const SKIP_KEYS = new Set(["key", "form_id", "form_name", "Date", "Time", "Page URL", "User Agent", "Remote IP", "Powered by"]);

function str(v: unknown): string {
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ");
  return v === undefined || v === null ? "" : String(v).trim();
}

function looksLikePhone(v: string): boolean {
  const digits = v.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 13 && /^[+\d\s()-]+$/.test(v.trim());
}

/** Elementor's simple webhook sends each field as "<field label>": value, plus form_name and a few
 * metadata fields. Labels differ per form ("Mobile", "Phone"...), so fields are matched loosely. */
export function parseWebsiteForm(body: FormBody): FormLead {
  const entries = Object.entries(body).filter(([k]) => !SKIP_KEYS.has(k));
  const pick = (re: RegExp): string => {
    for (const [k, v] of entries) {
      const s = str(v);
      if (re.test(k) && s) return s;
    }
    return "";
  };
  let phone = pick(/phone|mobile|whats|contact.?no|number|tel/i);
  if (!looksLikePhone(phone)) {
    const found = entries.map(([, v]) => str(v)).find(looksLikePhone);
    if (found) phone = found;
  }
  return {
    kind: "Website form",
    source: "Website",
    parentName: pick(/^(your )?name|parent|full.?name/i) || pick(/name/i),
    childName: pick(/child'?s?.?name|kid|ward/i),
    childAge: pick(/(^|[^a-z])age\b|dob|birth|how old/i),
    phone,
    email: pick(/e-?mail/i),
    area: pick(/address|city|area|locality|pin|zip/i),
    message: pick(/message|query|comment|enquiry|inquiry|question/i),
    honeypot: pick(/honeypot|hp_|leave.?blank|website_url/i),
    page: str(body.form_name) || str(body["Page URL"]),
    isTest: false,
  };
}

interface GoogleColumn {
  column_id?: string;
  column_name?: string;
  string_value?: string;
}

const GOOGLE_STANDARD = /^(FULL_NAME|FIRST_NAME|LAST_NAME|PHONE_NUMBER|EMAIL|WORK_EMAIL|WORK_PHONE|CITY|POSTAL_CODE|REGION|STREET_ADDRESS|COUNTRY)$/;

/** Google Ads lead form webhook body: { lead_id, user_column_data: [{ column_id, column_name,
 * string_value }], campaign_id, is_test, google_key }. Standard questions have fixed column_ids;
 * custom questions ("Child's age?", "Which program?") are matched by their text. */
export function parseGoogleLead(body: FormBody): FormLead {
  const cols = (Array.isArray(body.user_column_data) ? body.user_column_data : []) as GoogleColumn[];
  const byId: Record<string, string> = {};
  const extras: string[] = [];
  let childAge = "";
  let childName = "";
  for (const c of cols) {
    const id = String(c.column_id ?? "").toUpperCase();
    const label = String(c.column_name ?? id);
    const v = str(c.string_value);
    if (!v) continue;
    if (GOOGLE_STANDARD.test(id)) byId[id] = v;
    else if (/age|dob|birth|how old/i.test(label)) childAge = v;
    else if (/child|kid|ward|son|daughter/i.test(label)) childName = v;
    else extras.push(`${label}: ${v}`);
  }
  const isTest = body.is_test === true || body.is_test === "true";
  return {
    kind: `Google Ads lead form${isTest ? " (TEST from Google, delete me)" : ""}`,
    source: "Google Ads",
    parentName: byId.FULL_NAME || [byId.FIRST_NAME, byId.LAST_NAME].filter(Boolean).join(" "),
    childName,
    childAge,
    phone: byId.PHONE_NUMBER || byId.WORK_PHONE || "",
    email: byId.EMAIL || byId.WORK_EMAIL || "",
    area: [byId.STREET_ADDRESS, byId.CITY, byId.REGION, byId.POSTAL_CODE].filter(Boolean).join(", "),
    message: extras.join(" · "),
    honeypot: "",
    page: body.campaign_id ? `campaign ${str(body.campaign_id)}` : "",
    isTest,
  };
}

/** Constant-time-ish string compare, so a wrong key can't be guessed by timing. */
export function keyMatches(given: unknown, expected: string | undefined): boolean {
  if (!expected) return false;
  const g = str(given);
  if (g.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < g.length; i++) diff |= g.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
