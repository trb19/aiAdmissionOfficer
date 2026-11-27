/**
 * Morning enquiry digest for the GLO office, sent by email.
 *
 * Lists, from GLO Progress (Supabase leads table): enquiries added in the last 24 hours, calls due
 * today and overdue calls; and from the bot's own database: parents waiting for a call-back.
 *
 * Env (Render):
 *   OFFICE_DIGEST_EMAILS  comma-separated recipients
 *   SMTP_HOST, SMTP_PORT (default 465), SMTP_USER, SMTP_PASS, SMTP_FROM (default SMTP_USER)
 *     e.g. Gmail: smtp.gmail.com / 465 / the school Gmail address / a Google "app password"
 *   APP_URL               link in the email (default https://app.gloschools.com)
 * Uses PROGRESS_SUPABASE_URL / PROGRESS_SERVICE_KEY like progressLeads.ts.
 *
 * Triggered by POST /api/digest/run (x-api-key = CRM_SEND_SECRET), which a Supabase pg_cron job
 * calls at 9 AM IST. ?dry=1 returns the lists without sending anything.
 */
import nodemailer from "nodemailer";
import { listPendingCallBacks } from "./db.js";

const ACTIVE = ["Open", "Waiting", "Probable", "Less Likely"];
const MAX_ROWS = 40;

interface LeadRow {
  ref: number | null;
  parent_name: string;
  child_name: string;
  phone: string;
  source: string | null;
  next_followup: string | null;
}
interface Line { name: string; phone: string; note: string }

/** Today's date in India (the school's day), as YYYY-MM-DD. */
const todayIST = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

async function leads(filter: string): Promise<LeadRow[]> {
  const url = process.env.PROGRESS_SUPABASE_URL;
  const key = process.env.PROGRESS_SERVICE_KEY;
  if (!url || !key) throw new Error("PROGRESS_SUPABASE_URL / PROGRESS_SERVICE_KEY are not set");
  const res = await fetch(`${url}/rest/v1/leads?select=ref,parent_name,child_name,phone,source,next_followup&${filter}&limit=500`, {
    headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}) },
  });
  if (!res.ok) throw new Error(`Leads read failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as LeadRow[];
}

const who = (l: LeadRow) =>
  [l.parent_name, l.child_name && `(${l.child_name})`].filter(Boolean).join(" ") || "No name";
const nice = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

export interface Digest {
  date: string;
  newLeads: Line[];
  dueToday: Line[];
  overdue: Line[];
  callBacks: Line[];
}

export async function buildDigest(): Promise<Digest> {
  const today = todayIST();
  const active = `status=in.(${ACTIVE.map((s) => `"${s}"`).join(",")})`;
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [n, d, o, c] = await Promise.all([
    leads(`created_at=gte.${encodeURIComponent(since)}&order=created_at.desc`),
    leads(`${active}&next_followup=eq.${today}&order=ref`),
    leads(`${active}&next_followup=lt.${today}&order=next_followup`),
    listPendingCallBacks(),
  ]);
  return {
    date: today,
    newLeads: n.map((l) => ({ name: who(l), phone: l.phone, note: l.source ?? "" })),
    dueToday: d.map((l) => ({ name: who(l), phone: l.phone, note: l.ref ? `Lead ${l.ref}` : "" })),
    overdue: o.map((l) => ({ name: who(l), phone: l.phone, note: l.next_followup ? `due ${nice(l.next_followup)}` : "" })),
    callBacks: c.map((x) => ({ name: x.name, phone: x.phone, note: x.reason })),
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

function section(title: string, rows: Line[], empty: string): { html: string; text: string } {
  const shown = rows.slice(0, MAX_ROWS);
  const more = rows.length > MAX_ROWS ? `…and ${rows.length - MAX_ROWS} more in the app` : "";
  const html =
    `<h3 style="margin:18px 0 6px;color:#07ABEE">${esc(title)} (${rows.length})</h3>` +
    (rows.length
      ? `<table style="border-collapse:collapse;font-size:14px">${shown
          .map((r) => `<tr><td style="padding:3px 12px 3px 0">${esc(r.name)}</td><td style="padding:3px 12px 3px 0"><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></td><td style="padding:3px 0;color:#666">${esc(r.note)}</td></tr>`)
          .join("")}</table>${more ? `<p style="color:#666">${more}</p>` : ""}`
      : `<p style="color:#666">${esc(empty)}</p>`);
  const text = `${title} (${rows.length})\n` + (rows.length ? shown.map((r) => `- ${r.name}, ${r.phone}${r.note ? `, ${r.note}` : ""}`).join("\n") + (more ? `\n${more}` : "") : empty) + "\n";
  return { html, text };
}

export function renderDigest(d: Digest): { subject: string; html: string; text: string } {
  const app = process.env.APP_URL ?? "https://app.gloschools.com";
  const parts = [
    section("Parents asking for a call-back on WhatsApp", d.callBacks, "Nobody waiting."),
    section("Overdue calls", d.overdue, "Nothing overdue. Well done!"),
    section("Calls due today", d.dueToday, "No calls planned for today."),
    section("New enquiries in the last 24 hours", d.newLeads, "No new enquiries."),
  ];
  const subject = `GLO enquiries ${nice(d.date)}: ${d.callBacks.length} call-backs, ${d.overdue.length} overdue, ${d.dueToday.length} due today, ${d.newLeads.length} new`;
  const html = `<div style="font-family:Arial,sans-serif;color:#222;max-width:640px">
<p>Good morning! Here are today's enquiry calls.</p>${parts.map((p) => p.html).join("")}
<p style="margin-top:20px"><a href="${esc(app)}" style="background:#FAA619;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none">Open Enquiries in GLO Progress</a></p>
<p style="color:#999;font-size:12px">Sent every morning by the GLO admissions bot.</p></div>`;
  const text = `Good morning! Here are today's enquiry calls.\n\n${parts.map((p) => p.text).join("\n")}\nOpen the app: ${app}\n`;
  return { subject, html, text };
}

export async function sendOfficeDigest(dry = false): Promise<{ digest: Digest; sentTo: string[] }> {
  const digest = await buildDigest();
  const to = (process.env.OFFICE_DIGEST_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const host = process.env.SMTP_HOST;
  if (dry || to.length === 0) return { digest, sentTo: [] };
  if (!host || !process.env.SMTP_USER || !process.env.SMTP_PASS) throw new Error("SMTP_HOST / SMTP_USER / SMTP_PASS are not set");
  const port = Number(process.env.SMTP_PORT ?? 465);
  const mail = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  const { subject, html, text } = renderDigest(digest);
  await mail.sendMail({ from: process.env.SMTP_FROM ?? process.env.SMTP_USER, to, subject, html, text });
  return { digest, sentTo: to };
}
