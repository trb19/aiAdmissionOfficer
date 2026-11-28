/**
 * Fee emails to parents, from GLO Progress (tirth, 28 Nov 2026):
 *   after an edit or undo, if the office says yes:  updated invoice / corrected receipt / cancellation note
 *   1st of the month, from 6 AM IST:  the month's invoice
 *   5th, from 9 AM:                   a friendly reminder to families with anything unpaid (due on the 7th)
 *   8th, from 9 AM:                   overdue notice (the ₹200 late fee is added at 6 AM that day)
 *   whenever a payment is recorded:   a receipt (GLO Progress pokes /api/fees/poke so a sleeping bot wakes up)
 * Sent in batches (FEE_EMAIL_BATCH, default 20 families every 5 minutes) so Gmail's limits are never hit.
 * Every email sent is logged in GLO Progress fee_emails (child, month, kind), so nothing goes twice.
 *
 * Off until FEE_EMAILS_ON=1 is set on Render (tirth switches it on after the fees SQL is run).
 * Sent from fees@gloschools.com (FEE_SMTP_* in src/mail.ts), using PROGRESS_SUPABASE_URL / PROGRESS_SERVICE_KEY.
 */
import { feeMailer, feeFrom } from "./mail.js";

type Kind = "invoice" | "reminder" | "overdue";
interface Inv {
  id: string; child_id: string; month: string; plan: string; amount: number; due_day: string;
  paid: boolean; waived?: boolean; credit_used?: number; kind?: string; mode?: string | null;
}
interface Child { id: string; name: string; class_id: string | null; admission_no: string | null; mother_email: string | null; father_email: string | null; mother_name: string | null; father_name: string | null }

const BATCH = Number(process.env.FEE_EMAIL_BATCH ?? 20);

function db(path: string, init: RequestInit = {}) {
  const url = process.env.PROGRESS_SUPABASE_URL, key = process.env.PROGRESS_SERVICE_KEY;
  if (!url || !key) throw new Error("PROGRESS_SUPABASE_URL / PROGRESS_SERVICE_KEY are not set");
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}
async function get<T>(path: string): Promise<T[]> {
  const r = await db(path);
  if (!r.ok) throw new Error(`GLO Progress read failed (${r.status}): ${await r.text()}`);
  return (await r.json()) as T[];
}

const owed = (i: Inv) => Math.max(0, Number(i.amount) - Number(i.credit_used ?? 0));
const money = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const ml = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const day = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Which emails are due now (India time). */
export function dueKind(now = new Date()): { kind: Kind; month: string } | null {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const d = ist.getUTCDate(), h = ist.getUTCHours(), month = ist.toISOString().slice(0, 7);
  if (d === 1 && h >= 6) return { kind: "invoice", month };
  if (d === 5 && h >= 9 && h < 20) return { kind: "reminder", month };
  if (d === 8 && h >= 9 && h < 20) return { kind: "overdue", month };
  return null;
}

export function renderFeeEmail(kind: Kind, month: string, child: Child, mine: Inv[], earlier: number, s: Record<string, string>) {
  const lines = mine.filter((i) => !i.waived);
  const credit = lines.reduce((t, i) => t + (i.paid ? 0 : Number(i.credit_used ?? 0)), 0);
  const paid = lines.filter((i) => i.paid).reduce((t, i) => t + Number(i.amount), 0);
  const total = lines.reduce((t, i) => t + Number(i.amount), 0);
  const balance = Math.max(0, total - paid - credit) + earlier;
  const due = lines.filter((i) => i.kind !== "late_fee").map((i) => i.due_day).sort()[0] ?? `${month}-07`;
  const school = s.school_name || "GLO Preschool";
  const late = Number(s.late_fee || 200);
  const subject =
    kind === "invoice" ? `${school}: ${ml(month)} fee invoice for ${child.name} (${money(balance)})`
    : kind === "reminder" ? `Reminder: ${child.name}'s ${ml(month)} fees are due on ${day(due)}`
    : `Overdue: ${child.name}'s ${ml(month)} fees (${money(balance)})`;
  const intro =
    kind === "invoice" ? `Here is the fee invoice for <b>${esc(child.name)}</b> for <b>${ml(month)}</b>. Please pay by <b>${day(due)}</b>; a late fee of ${money(late)} is added after that.`
    : kind === "reminder" ? `A gentle reminder that <b>${esc(child.name)}</b>'s fees for ${ml(month)} are due on <b>${day(due)}</b>. If you have already paid, thank you, and please ignore this email.`
    : `<b>${esc(child.name)}</b>'s fees for ${ml(month)} were due on ${day(due)} and are still unpaid, so a late fee of ${money(late)} has been added. If you have already paid, please reply with the transaction ID so we can update our records.`;
  const rows = lines.map((i) => `<tr><td style="padding:6px 10px 6px 0">${esc(i.plan)}</td><td style="padding:6px 0;text-align:right">${money(Number(i.amount))}</td><td style="padding:6px 0 6px 12px;color:${i.paid ? "#1b7f3b" : "#999"}">${i.paid ? (i.mode === "credit" ? "Paid from credit" : "Paid") : ""}</td></tr>`).join("");
  const sum = (label: string, v: string, bold = false) => `<tr><td style="padding:4px 10px 4px 0;${bold ? "font-weight:bold;border-top:2px solid #222" : ""}">${label}</td><td style="padding:4px 0;text-align:right;${bold ? "font-weight:bold;border-top:2px solid #222" : ""}">${v}</td><td></td></tr>`;
  const payHow = [
    s.pay_upi ? `UPI ID: <b>${esc(s.pay_upi)}</b> (GPay, PhonePe, Paytm, BHIM)` : "",
    s.pay_account ? `Bank transfer: <b>${esc(s.pay_payee || "")}</b>, ${esc(s.pay_bank || "")}, A/c <b>${esc(s.pay_account)}</b>, IFSC <b>${esc(s.pay_ifsc || "")}</b>` : "",
    "Or cash at the school office.",
  ].filter(Boolean).map((x) => `<li style="margin:3px 0">${x}</li>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;color:#222;max-width:600px">
<div style="height:5px;background:linear-gradient(90deg,#07ABEE 75%,#FAA619 75%)"></div>
<h2 style="color:#07ABEE;margin:16px 0 4px">${esc(school)}</h2>
<p>Dear Parent,</p><p>${intro}</p>
<table style="border-collapse:collapse;font-size:14px;margin:10px 0">${rows}
${sum("This month", money(total))}${earlier ? sum("Earlier dues", money(earlier)) : ""}${paid ? sum("Paid", `− ${money(paid)}`) : ""}${credit ? sum("Paid from credit balance", `− ${money(credit)}`) : ""}${sum("Balance to pay", money(balance), true)}</table>
${balance > 0 ? `<p style="margin-bottom:4px"><b>How to pay</b></p><ul style="margin-top:0;padding-left:18px">${payHow}</ul>` : `<p style="color:#1b7f3b"><b>Nothing to pay. Thank you!</b></p>`}
<p>The full invoice is in the GLO parent app. For any question, just reply to this email.</p>
<p>Warm regards,<br>Team GLO</p></div>`;
  const text = `${subject}\n\n${intro.replace(/<[^>]+>/g, "")}\n\n${lines.map((i) => `${i.plan}: ${money(Number(i.amount))}${i.paid ? " (paid)" : ""}`).join("\n")}\nBalance to pay: ${money(balance)}\n${s.pay_upi ? `UPI ID: ${s.pay_upi}\n` : ""}\nTeam GLO`;
  return { subject, html, text, balance };
}

/** Sends the next batch of emails that are due now. Returns how many were sent. */
export async function sendFeeBatch(now = new Date(), dry = false): Promise<{ kind?: Kind; sent: string[]; skipped: number }> {
  const due = dueKind(now);
  if (!due) return { sent: [], skipped: 0 };
  const { kind, month } = due;
  const [invs, kids, settingRows, done] = await Promise.all([
    get<Inv>(`fee_invoices?select=id,child_id,month,plan,amount,due_day,paid,waived,credit_used,kind,mode&month=lte.${month}`),
    get<Child>(`children?select=id,name,class_id,admission_no,mother_email,father_email,mother_name,father_name&active=eq.true`),
    get<{ key: string; value: unknown }>(`settings?select=key,value`),
    get<{ child_id: string }>(`fee_emails?select=child_id&month=eq.${month}&kind=eq.${kind}`),
  ]);
  const s = Object.fromEntries(settingRows.map((r) => [r.key, typeof r.value === "string" ? r.value : String(r.value ?? "")]));
  const sentAlready = new Set(done.map((d) => d.child_id));
  const out: string[] = [];
  let skipped = 0;
  for (const c of kids) {
    if (out.length >= BATCH) break;
    if (sentAlready.has(c.id)) continue;
    const mine = invs.filter((i) => i.child_id === c.id && i.month === month);
    const earlier = invs.filter((i) => i.child_id === c.id && i.month < month && !i.paid && !i.waived).reduce((t, i) => t + owed(i), 0);
    const to = [...new Set([c.mother_email, c.father_email].map((e) => (e ?? "").trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
    const unpaid = mine.some((i) => !i.paid && !i.waived && owed(i) > 0) || earlier > 0;
    // invoices go to everyone with fees this month; reminders only to families who still owe
    const wanted = mine.length > 0 && to.length > 0 && (kind === "invoice" || unpaid);
    if (!wanted) { skipped++; if (!dry) await log(c.id, month, kind, ""); continue; }
    const mail = renderFeeEmail(kind, month, c, mine, earlier, s);
    if (!dry) {
      await feeMailer().sendMail({ from: feeFrom(s.school_name || "GLO Preschool"), to, subject: mail.subject, html: mail.html, text: mail.text });
      await log(c.id, month, kind, to.join(","));
    }
    out.push(`${c.name} → ${to.join(", ")}`);
  }
  return { kind, sent: out, skipped };
}

async function log(child: string, month: string, kind: Kind, sentTo: string) {
  const r = await db("fee_emails", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify([{ child_id: child, month, kind, sent_to: sentTo }]) });
  if (!r.ok) throw new Error(`fee_emails log failed (${r.status}): ${await r.text()}`);
}

// ---------- Receipts ----------
interface PaidRow extends Inv { receipt_no: string; paid_on: string; reference: string; recorded_at: string }

export function renderReceipt(child: Child, rows: PaidRow[], s: Record<string, string>) {
  const school = s.school_name || "GLO Preschool";
  const total = rows.reduce((t, r) => t + owed(r), 0);
  const r0 = rows[0];
  const MODE: Record<string, string> = { upi: "UPI", bank: "Bank transfer", cash: "Cash" };
  const subject = `${school}: receipt ${r0.receipt_no} for ${child.name} (${money(total)})`;
  const html = `<div style="font-family:Arial,sans-serif;color:#222;max-width:600px">
<div style="height:5px;background:linear-gradient(90deg,#07ABEE 75%,#FAA619 75%)"></div>
<h2 style="color:#07ABEE;margin:16px 0 4px">${esc(school)}</h2>
<p>Dear Parent,</p><p>Thank you! We have received <b>${money(total)}</b> for <b>${esc(child.name)}</b>.</p>
<table style="border-collapse:collapse;font-size:14px;margin:10px 0">
${rows.map((r) => `<tr><td style="padding:5px 12px 5px 0">${esc(r.plan)} <span style="color:#888">· ${ml(r.month)}</span></td><td style="padding:5px 0;text-align:right">${money(owed(r))}</td></tr>`).join("")}
<tr><td style="padding:6px 12px 6px 0;font-weight:bold;border-top:2px solid #222">Amount received</td><td style="padding:6px 0;text-align:right;font-weight:bold;border-top:2px solid #222">${money(total)}</td></tr></table>
<p style="color:#555;font-size:13px">Receipt no. <b>${esc(r0.receipt_no)}</b> · ${day(r0.paid_on)} · ${MODE[r0.mode ?? ""] ?? esc(r0.mode ?? "")}${r0.reference ? ` · Ref. ${esc(r0.reference)}` : ""}</p>
<p>The receipt is also in the GLO parent app.</p><p>Warm regards,<br>Team GLO</p></div>`;
  const text = `${subject}\n\nThank you! We have received ${money(total)} for ${child.name}.\n${rows.map((r) => `${r.plan} (${ml(r.month)}): ${money(owed(r))}`).join("\n")}\nReceipt no. ${r0.receipt_no}, ${day(r0.paid_on)}\n\nTeam GLO`;
  return { subject, html, text };
}

/** Emails a receipt for every payment recorded in the last 3 days that has not had one yet (not credit-only ones). */
export async function sendReceipts(dry = false): Promise<string[]> {
  const since = new Date(Date.now() - 3 * 86400_000).toISOString();
  const paid = await get<PaidRow>(`fee_invoices?select=id,child_id,month,plan,amount,due_day,paid,credit_used,kind,mode,receipt_no,paid_on,reference,recorded_at&paid=eq.true&receipt_no=not.is.null&mode=neq.credit&recorded_at=gte.${encodeURIComponent(since)}`);
  if (!paid.length) return [];
  const done = new Set((await get<{ receipt_no: string }>(`receipt_emails?select=receipt_no&receipt_no=in.(${[...new Set(paid.map((p) => `"${p.receipt_no}"`))].join(",")})`)).map((d) => d.receipt_no));
  const groups = new Map<string, PaidRow[]>();
  for (const p of paid) if (!done.has(p.receipt_no)) groups.set(p.receipt_no, [...(groups.get(p.receipt_no) ?? []), p]);
  if (!groups.size) return [];
  const ids = [...new Set([...groups.values()].map((g) => g[0].child_id))];
  const [kids, settingRows] = await Promise.all([
    get<Child>(`children?select=id,name,class_id,admission_no,mother_email,father_email,mother_name,father_name&id=in.(${ids.join(",")})`),
    get<{ key: string; value: unknown }>(`settings?select=key,value`),
  ]);
  const s = Object.fromEntries(settingRows.map((r) => [r.key, typeof r.value === "string" ? r.value : String(r.value ?? "")]));
  const out: string[] = [];
  for (const [no, rows] of groups) {
    if (out.length >= BATCH) break;
    const c = kids.find((k) => k.id === rows[0].child_id);
    const to = c ? [...new Set([c.mother_email, c.father_email].map((e) => (e ?? "").trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))] : [];
    if (!dry && c && to.length) {
      const m = renderReceipt(c, rows, s);
      await feeMailer().sendMail({ from: feeFrom(s.school_name || "GLO Preschool"), to, subject: m.subject, html: m.html, text: m.text });
    }
    if (!dry) {
      const r = await db("receipt_emails", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify([{ receipt_no: no, child_id: rows[0].child_id, sent_to: to.join(",") }]) });
      if (!r.ok) throw new Error(`receipt_emails log failed (${r.status}): ${await r.text()}`);
    }
    out.push(`${no} ${c?.name ?? "?"} → ${to.join(", ") || "(no email)"}`);
  }
  return out;
}

// ---------- "Mail the parent?" after a change (tirth, 28 Nov 2026) ----------
// When an invoice or payment is edited or undone in GLO Progress, the office is asked whether to mail the parent.
// Yes adds a row to fee_mail_requests; this sends it: the updated invoice, the corrected receipt, or a short note
// that a payment entry was cancelled (with what is now due).
interface MailReq { id: string; child_id: string; kind: "invoice" | "receipt" | "undone"; month: string | null; receipt_no: string | null }

const emailsOf = (c?: Child) => (c ? [...new Set([c.mother_email, c.father_email].map((e) => (e ?? "").trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))] : []);

export async function sendRequested(dry = false): Promise<string[]> {
  const reqs = await get<MailReq>(`fee_mail_requests?select=id,child_id,kind,month,receipt_no&sent_at=is.null&error=is.null&order=created_at&limit=${BATCH}`);
  if (!reqs.length) return [];
  const ids = [...new Set(reqs.map((r) => r.child_id))];
  const [kids, invs, settingRows] = await Promise.all([
    get<Child>(`children?select=id,name,class_id,admission_no,mother_email,father_email,mother_name,father_name&id=in.(${ids.join(",")})`),
    get<PaidRow>(`fee_invoices?select=id,child_id,month,plan,amount,due_day,paid,waived,credit_used,kind,mode,receipt_no,paid_on,reference,recorded_at&child_id=in.(${ids.join(",")})`),
    get<{ key: string; value: unknown }>(`settings?select=key,value`),
  ]);
  const s = Object.fromEntries(settingRows.map((r) => [r.key, typeof r.value === "string" ? r.value : String(r.value ?? "")]));
  const school = s.school_name || "GLO Preschool";
  const out: string[] = [];
  for (const r of reqs) {
    const c = kids.find((k) => k.id === r.child_id);
    const to = emailsOf(c);
    const mine = invs.filter((i) => i.child_id === r.child_id);
    let mail: { subject: string; html: string; text: string } | null = null;
    if (c && r.kind === "invoice" && r.month) {
      const month = r.month;
      const earlier = mine.filter((i) => i.month < month && !i.paid && !i.waived).reduce((t, i) => t + owed(i), 0);
      const m = renderFeeEmail("invoice", month, c, mine.filter((i) => i.month === month), earlier, s);
      mail = { subject: `Updated: ${m.subject}`, html: m.html.replace("<p>Dear Parent,</p>", "<p>Dear Parent,</p><p><b>This invoice has been updated and replaces the earlier one.</b></p>"), text: `This invoice has been updated and replaces the earlier one.\n\n${m.text}` };
    } else if (c && r.kind === "receipt" && r.receipt_no) {
      const rows = mine.filter((i) => i.paid && i.receipt_no === r.receipt_no);
      if (rows.length) {
        const m = renderReceipt(c, rows, s);
        mail = { subject: `Corrected: ${m.subject}`, html: m.html.replace("<p>Dear Parent,</p>", "<p>Dear Parent,</p><p><b>This receipt has been corrected and replaces the earlier one.</b></p>"), text: `This receipt has been corrected and replaces the earlier one.\n\n${m.text}` };
      }
    } else if (c && r.kind === "undone") {
      const due = mine.filter((i) => !i.paid && !i.waived).reduce((t, i) => t + owed(i), 0);
      const subject = `${school}: receipt ${r.receipt_no ?? ""} for ${c.name} cancelled`;
      const html = `<div style="font-family:Arial,sans-serif;color:#222;max-width:600px">
<div style="height:5px;background:linear-gradient(90deg,#07ABEE 75%,#FAA619 75%)"></div>
<h2 style="color:#07ABEE;margin:16px 0 4px">${esc(school)}</h2>
<p>Dear Parent,</p><p>Receipt <b>${esc(r.receipt_no ?? "")}</b> for <b>${esc(c.name)}</b> was recorded by mistake and has been cancelled. Please ignore that receipt.</p>
<p>${due > 0 ? `The amount now due is <b>${money(due)}</b>. If you have already paid, please reply with the transaction ID and we will update our records.` : "Nothing is due at the moment."}</p>
<p>We are sorry for the confusion.</p><p>Warm regards,<br>Team GLO</p></div>`;
      mail = { subject, html, text: `Receipt ${r.receipt_no ?? ""} for ${c.name} was recorded by mistake and has been cancelled.${due > 0 ? ` Amount now due: ${money(due)}.` : ""}\n\nTeam GLO` };
    }
    const note = !c ? "child not found" : !to.length ? "no parent email" : !mail ? "nothing to send" : null;
    if (!dry) {
      if (mail && to.length) await feeMailer().sendMail({ from: feeFrom(school), to, subject: mail.subject, html: mail.html, text: mail.text });
      const u = await db(`fee_mail_requests?id=eq.${r.id}`, { method: "PATCH", body: JSON.stringify(note ? { error: note } : { sent_at: new Date().toISOString(), sent_to: to.join(",") }) });
      if (!u.ok) throw new Error(`fee_mail_requests update failed (${u.status}): ${await u.text()}`);
    }
    out.push(`${r.kind} ${c?.name ?? "?"} → ${note ?? to.join(", ")}`);
  }
  return out;
}

let busy = false;
/** One round: receipts first, then any invoice / reminder batch that is due. Safe to call often. */
export async function feeRound(): Promise<void> {
  if (busy || process.env.FEE_EMAILS_ON !== "1") return;
  busy = true;
  try {
    const rec = await sendReceipts();
    if (rec.length) console.log(`Receipts emailed: ${rec.length}`);
    const asked = await sendRequested();
    if (asked.length) console.log(`Requested fee emails: ${asked.length}`);
    if (dueKind()) {
      const r = await sendFeeBatch();
      if (r.sent.length) console.log(`Fee emails (${r.kind}): sent ${r.sent.length}, skipped ${r.skipped}`);
    }
  } catch (err) {
    console.error("Fee emails failed, will retry:", err);
  } finally {
    busy = false;
  }
}

export function startFeeEmailTimer(): void {
  if (process.env.FEE_EMAILS_ON !== "1") return;
  setTimeout(feeRound, 30_000);
  setInterval(feeRound, 5 * 60_000);
}
