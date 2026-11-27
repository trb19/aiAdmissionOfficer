/**
 * Morning enquiry digest for the GLO office, sent on WhatsApp.
 *
 * Counts, from GLO Progress (Supabase leads table): enquiries added in the last 24 hours, calls due
 * today, overdue calls; and from the bot's own database: parents waiting for a call-back.
 * Sends them as the approved Utility template OFFICE_DIGEST_TEMPLATE (default glo_office_digest_v1,
 * 4 positional variables) to every number in OFFICE_DIGEST_PHONES (comma separated, 91XXXXXXXXXX).
 *
 * Triggered by POST /api/digest/run (x-api-key = CRM_SEND_SECRET), which a Supabase pg_cron job
 * calls at 9 AM IST. ?dry=1 returns the counts without sending anything.
 */
import { countPendingCallBacks } from "./db.js";
import { sendWhatsAppTemplate } from "./whatsapp.js";

const ACTIVE = ["Open", "Waiting", "Probable", "Less Likely"];

/** Today's date in India (the school's day), as YYYY-MM-DD. */
function todayIST(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

async function countLeads(filter: string): Promise<number> {
  const url = process.env.PROGRESS_SUPABASE_URL;
  const key = process.env.PROGRESS_SERVICE_KEY;
  if (!url || !key) throw new Error("PROGRESS_SUPABASE_URL / PROGRESS_SERVICE_KEY are not set");
  const res = await fetch(`${url}/rest/v1/leads?select=id&${filter}`, {
    method: "HEAD",
    headers: {
      apikey: key,
      ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
      Prefer: "count=exact",
      Range: "0-0",
    },
  });
  if (!res.ok && res.status !== 206) throw new Error(`Leads count failed (${res.status})`);
  // Content-Range: 0-0/123  or  */0
  const total = (res.headers.get("content-range") ?? "").split("/")[1];
  return Number(total) || 0;
}

export interface DigestCounts {
  newLeads: number;
  dueToday: number;
  overdue: number;
  callBacks: number;
}

export async function digestCounts(): Promise<DigestCounts> {
  const today = todayIST();
  const active = `status=in.(${ACTIVE.map((s) => `"${s}"`).join(",")})`;
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [newLeads, dueToday, overdue, callBacks] = await Promise.all([
    countLeads(`created_at=gte.${encodeURIComponent(since)}`),
    countLeads(`${active}&next_followup=eq.${today}`),
    countLeads(`${active}&next_followup=lt.${today}`),
    countPendingCallBacks(),
  ]);
  return { newLeads, dueToday, overdue, callBacks };
}

export async function sendOfficeDigest(dry = false): Promise<{ counts: DigestCounts; sentTo: string[] }> {
  const counts = await digestCounts();
  const phones = (process.env.OFFICE_DIGEST_PHONES ?? "")
    .split(",")
    .map((p) => p.replace(/\D/g, ""))
    .filter(Boolean)
    .map((p) => (p.length === 10 ? `91${p}` : p));
  if (dry || phones.length === 0) return { counts, sentTo: [] };
  const name = process.env.OFFICE_DIGEST_TEMPLATE ?? "glo_office_digest_v1";
  const vars = [counts.newLeads, counts.dueToday, counts.overdue, counts.callBacks].map(String);
  for (const p of phones) await sendWhatsAppTemplate(p, name, "en", vars);
  return { counts, sentTo: phones };
}
