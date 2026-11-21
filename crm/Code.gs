// ============================================================
//  GLO LEADS CRM — Web App Backend (Code.gs)
//  Deploy as Web App: Execute as "Me", Access "Anyone"
// ============================================================

// Bound to the new "Glo Leads 2026 (New) V1" spreadsheet.
// SHEET_ID can be overridden per project in Project Settings > Script Properties, so the TEST copy
// of this CRM can point at a test spreadsheet with the exact same code. Falls back to the live sheet.
const SHEET_ID =
  PropertiesService.getScriptProperties().getProperty("SHEET_ID") || "1tWfRMsbzLpiC15gpA4dH9zKQDW9hc6AJK2zDM0AwPZk";
const SHEET_NAME = "CRM";
const LOG_SHEET = "FollowUps";

// FIX: Verified column indices match the actual sheet layout exactly
// A=ID, B=DateInquiry, C=ChildName, D=Class, E=ParentName, F=Phone,
// G=Age, H=Status, I=LastContact, J=NextFollowup, K=Source, L=Remarks, M=Address, N=Quality
const COL = {
  ID: 1,
  DATE_INQUIRY: 2,
  CHILD_NAME: 3,
  CLASS: 4,
  PARENT_NAME: 5,
  PHONE: 6,
  AGE: 7,
  STATUS: 8,
  LAST_CONTACT: 9,
  NEXT_FOLLOWUP: 10,
  SOURCE: 11,
  REMARKS: 12,
  ADDRESS: 13,
  QUALITY: 14, // Lead check: Hot / Warm / Cold / Spam (see scoreLead_)
};

// Active statuses — Converted and Lost are excluded from overdue
const ACTIVE_STATUSES = ["Open", "Waiting", "Probable", "Less Likely"];

// Shared PIN gate — a lightweight front door so a random person who
// stumbles onto the URL can't see lead data. Not bank-grade security
// (it's one shared PIN, checked server-side so it's not visible in the
// page source) — good enough to keep the app private among staff.
// The PIN lives ONLY in Project Settings > Script Properties (APP_PIN), never in this source file:
// this code is kept in a public GitHub repo. If APP_PIN isn't set, nobody can log in.
const APP_PIN = PropertiesService.getScriptProperties().getProperty("APP_PIN") || "";

function checkPin(pin) {
  try {
    if (!APP_PIN) return { ok: false, error: "PIN is not set up: add APP_PIN in Project Settings > Script Properties." };
    return { ok: true, valid: String(pin || "").trim() === APP_PIN };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Serve web app ────────────────────────────────────────────
function doGet() {
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("GLO Leads CRM")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ── Helpers ──────────────────────────────────────────────────
function getSheet() {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
}

function getLogSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let s = ss.getSheetByName(LOG_SHEET);
  if (!s) {
    s = ss.insertSheet(LOG_SHEET);
    s.appendRow(["Timestamp", "Lead ID", "Parent Name", "Phone", "Outcome", "Note Added", "Next Follow-up"]);
    s.getRange(1, 1, 1, 7).setBackground("#16213e").setFontColor("#fff").setFontWeight("bold");
    s.setFrozenRows(1);
  }
  return s;
}

function fmt(val) {
  if (!val || val === "") return "";
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return "";
    // FIX: Always format as dd-MMM-yyyy string — never return a raw Date object
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "dd-MMM-yyyy");
  } catch (e) {
    return "";
  }
}

// FIX: Source must be a plain string — if a Date leaked in, return 'Other'
function fmtLog(val) {
  if (!val || val === "") return "";
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return "";
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "dd MMM yyyy");
  } catch (e) {
    return "";
  }
}
function safeSource(val) {
  if (!val || val === "") return "Other";
  if (val instanceof Date) return "Other";
  const s = String(val).trim();
  // If it looks like a date string, it's the wrong column
  if (/^\d{1,2}[\-\/]\w{3}[\-\/]\d{4}$/.test(s)) return "Other";
  if (/^\w{3}\s\w{3}\s\d{2}/.test(s)) return "Other"; // JS Date toString
  return s || "Other";
}

function nextId(sheet) {
  const lr = sheet.getLastRow();
  if (lr < 2) return 1;
  const ids = sheet
    .getRange(2, COL.ID, lr - 1, 1)
    .getValues()
    .flat()
    .filter((v) => v !== "" && !isNaN(v))
    .map(Number);
  return ids.length ? Math.max(...ids) + 1 : 1;
}

// FIX: Slim lead object — only send fields needed for tiles to reduce payload size
function rowToLead(row) {
  return {
    id: row[COL.ID - 1],
    dateInquiry: fmt(row[COL.DATE_INQUIRY - 1]),
    childName: String(row[COL.CHILD_NAME - 1] || ""),
    classInt: String(row[COL.CLASS - 1] || ""),
    parentName: String(row[COL.PARENT_NAME - 1] || ""),
    phone: String(row[COL.PHONE - 1] || ""),
    age: String(row[COL.AGE - 1] || ""),
    status: String(row[COL.STATUS - 1] || "Open"),
    lastContact: fmt(row[COL.LAST_CONTACT - 1]),
    nextFollowup: fmt(row[COL.NEXT_FOLLOWUP - 1]),
    source: safeSource(row[COL.SOURCE - 1]),
    remarks: String(row[COL.REMARKS - 1] || ""),
    address: String(row[COL.ADDRESS - 1] || ""),
    quality: String(row[COL.QUALITY - 1] || ""),
  };
}

// ── ADD LEAD ─────────────────────────────────────────────────
function addLead(data) {
  try {
    const sheet = getSheet();
    const id = nextId(sheet);
    const today = new Date();
    const nf = data.nextFollowup ? new Date(data.nextFollowup) : "";

    sheet.appendRow([
      id,
      today,
      data.childName || "",
      data.classInt || "",
      data.parentName,
      data.phone,
      data.age || "",
      data.status || "Open",
      today,
      nf,
      data.source || "",
      data.remarks || "",
      data.address || "",
      data.quality || "",
    ]);
    if (data.quality) ensureQualityHeader_(sheet);

    const r = sheet.getLastRow();
    sheet.getRange(r, COL.DATE_INQUIRY).setNumberFormat("dd-MMM-yyyy");
    sheet.getRange(r, COL.LAST_CONTACT).setNumberFormat("dd-MMM-yyyy");
    if (nf) sheet.getRange(r, COL.NEXT_FOLLOWUP).setNumberFormat("dd-MMM-yyyy");

    return { ok: true, id, name: data.parentName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── DUPLICATE PHONE CHECK ──────────────────────────────────────
// Called while staff are typing a phone number into Add Lead, so they
// can catch an accidental re-entry of an existing family before saving.
// Matches on the last 10 digits, ignoring any country-code prefix.
function normalizePhone_(phone) {
  var d = String(phone || "").replace(/\D/g, "");
  if (d.length < 10) return "";
  return d.slice(-10);
}

function checkDuplicatePhone(phone) {
  try {
    const target = normalizePhone_(phone);
    if (!target) return { ok: true, found: false };

    const sheet = getSheet();
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      const pn = String(data[i][COL.PARENT_NAME - 1] || "").trim();
      if (!pn) continue;
      const existing = normalizePhone_(data[i][COL.PHONE - 1]);
      if (existing && existing === target) {
        return { ok: true, found: true, lead: rowToLead(data[i]) };
      }
    }
    return { ok: true, found: false };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── SEARCH LEAD ──────────────────────────────────────────────
function searchLead(query) {
  try {
    const sheet = getSheet();
    const data = sheet.getDataRange().getValues();
    const q = String(query).replace(/\D/g, "");
    const qt = String(query).toLowerCase().trim();

    for (let i = 1; i < data.length; i++) {
      if (!data[i][COL.PARENT_NAME - 1]) continue;
      const phone = String(data[i][COL.PHONE - 1]).replace(/\D/g, "");
      const parent = String(data[i][COL.PARENT_NAME - 1]).toLowerCase();
      const child = String(data[i][COL.CHILD_NAME - 1] || "").toLowerCase();
      // FIX: lowercase the ID before comparing — some leads have been
      // given non-numeric IDs (e.g. "GLO-0043") by hand-editing the
      // sheet directly, and comparing case-sensitively against the
      // lowercased search text made a lead's own ID fail to match itself.
      const id = String(data[i][COL.ID - 1])
        .trim()
        .toLowerCase();

      if (
        (q.length >= 5 && phone.includes(q)) ||
        (qt.length > 1 && (parent.includes(qt) || child.includes(qt))) ||
        id === qt
      ) {
        return { ok: true, lead: rowToLead(data[i]) };
      }
    }
    return { ok: false, error: "No lead found for: " + query };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── UPDATE LEAD (full edit from the detail modal) ─────────────
function updateLeadFull(data) {
  try {
    const sheet = getSheet();
    const rows = sheet.getDataRange().getValues();

    let targetRow = -1;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][COL.ID - 1]) === String(data.id)) {
        targetRow = i + 1;
        break;
      }
    }
    if (targetRow < 0) return { ok: false, error: "Lead ID not found" };
    if (!data.parentName || !data.phone) return { ok: false, error: "Parent Name and Phone are required" };

    const dInq = data.dateInquiry ? new Date(data.dateInquiry) : "";
    const dLc = data.lastContact ? new Date(data.lastContact) : "";
    const dNf = data.nextFollowup ? new Date(data.nextFollowup) : "";

    sheet.getRange(targetRow, COL.DATE_INQUIRY).setValue(dInq);
    sheet.getRange(targetRow, COL.CHILD_NAME).setValue(data.childName || "");
    sheet.getRange(targetRow, COL.CLASS).setValue(data.classInt || "");
    sheet.getRange(targetRow, COL.PARENT_NAME).setValue(data.parentName);
    sheet.getRange(targetRow, COL.PHONE).setValue(data.phone);
    sheet.getRange(targetRow, COL.AGE).setValue(data.age || "");
    sheet.getRange(targetRow, COL.STATUS).setValue(data.status || "Open");
    sheet.getRange(targetRow, COL.LAST_CONTACT).setValue(dLc);
    sheet.getRange(targetRow, COL.NEXT_FOLLOWUP).setValue(dNf);
    sheet.getRange(targetRow, COL.SOURCE).setValue(data.source || "");
    sheet.getRange(targetRow, COL.REMARKS).setValue(data.remarks || "");
    sheet.getRange(targetRow, COL.ADDRESS).setValue(data.address || "");
    if (data.quality !== undefined) {
      sheet.getRange(targetRow, COL.QUALITY).setValue(data.quality || "");
      if (data.quality) ensureQualityHeader_(sheet);
    }

    if (dInq) sheet.getRange(targetRow, COL.DATE_INQUIRY).setNumberFormat("dd-MMM-yyyy");
    if (dLc) sheet.getRange(targetRow, COL.LAST_CONTACT).setNumberFormat("dd-MMM-yyyy");
    if (dNf) sheet.getRange(targetRow, COL.NEXT_FOLLOWUP).setNumberFormat("dd-MMM-yyyy");
    else sheet.getRange(targetRow, COL.NEXT_FOLLOWUP).clearContent();

    const updatedRow = sheet.getRange(targetRow, 1, 1, 13).getValues()[0];
    return { ok: true, lead: rowToLead(updatedRow) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── LOG FOLLOW-UP ─────────────────────────────────────────────
function logFollowUp(data) {
  try {
    const sheet = getSheet();
    const rows = sheet.getDataRange().getValues();

    let targetRow = -1;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][COL.ID - 1]) === String(data.leadId)) {
        targetRow = i + 1;
        break;
      }
    }
    if (targetRow < 0) return { ok: false, error: "Lead ID not found" };

    const today = new Date();
    const dateStr = fmtLog(today);
    const nf = data.nextFollowup ? new Date(data.nextFollowup) : "";

    const existing = String(rows[targetRow - 1][COL.REMARKS - 1]).trim();
    const newEntry = "[" + dateStr + "] " + data.outcome + ": " + data.note;
    const updated = existing ? existing + "\n" + newEntry : newEntry;

    sheet.getRange(targetRow, COL.STATUS).setValue(data.newStatus);
    sheet.getRange(targetRow, COL.LAST_CONTACT).setValue(today).setNumberFormat("dd-MMM-yyyy");
    sheet.getRange(targetRow, COL.REMARKS).setValue(updated);
    if (nf) {
      sheet.getRange(targetRow, COL.NEXT_FOLLOWUP).setValue(nf).setNumberFormat("dd-MMM-yyyy");
    } else {
      sheet.getRange(targetRow, COL.NEXT_FOLLOWUP).clearContent();
    }

    getLogSheet().appendRow([
      today,
      data.leadId,
      rows[targetRow - 1][COL.PARENT_NAME - 1],
      rows[targetRow - 1][COL.PHONE - 1],
      data.outcome,
      data.note,
      nf || "",
    ]);

    return { ok: true, name: rows[targetRow - 1][COL.PARENT_NAME - 1] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── LOG WHATSAPP SEND ──────────────────────────────────────────
// Called client-side right after a wa.me link is opened, so a WhatsApp
// touch gets recorded automatically (Remarks + Last Contact) without
// staff having to separately fill in "Log Follow-up" for it.
function logWaSend(leadId, label) {
  try {
    const sheet = getSheet();
    const rows = sheet.getDataRange().getValues();

    let targetRow = -1;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][COL.ID - 1]) === String(leadId)) {
        targetRow = i + 1;
        break;
      }
    }
    if (targetRow < 0) return { ok: false, error: "Lead ID not found" };

    const today = new Date();
    const dateStr = fmtLog(today);
    const existing = String(rows[targetRow - 1][COL.REMARKS - 1]).trim();
    const newEntry = "[" + dateStr + "] WhatsApp sent: " + label;
    const updated = existing ? existing + "\n" + newEntry : newEntry;

    sheet.getRange(targetRow, COL.REMARKS).setValue(updated);
    sheet.getRange(targetRow, COL.LAST_CONTACT).setValue(today).setNumberFormat("dd-MMM-yyyy");

    const updatedRow = sheet.getRange(targetRow, 1, 1, 13).getValues()[0];
    return { ok: true, lead: rowToLead(updatedRow) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── ALL LEADS ─────────────────────────────────────────────────
// FIX: Return only essential fields to reduce payload; skip blank rows
function getAllLeads() {
  try {
    const sheet = getSheet();
    const data = sheet.getDataRange().getValues();
    const leads = [];

    for (let i = 1; i < data.length; i++) {
      const pn = String(data[i][COL.PARENT_NAME - 1] || "").trim();
      if (!pn) continue;
      leads.push(rowToLead(data[i]));
    }

    leads.reverse(); // newest first
    return { ok: true, leads };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── OVERDUE LEADS ─────────────────────────────────────────────
// FIX: Only include ACTIVE statuses (Open, Waiting, Probable, Less Likely)
// Converted and Lost are excluded — they don't need follow-up
//
// Shared by both getOverdue() (used by the web app's Overdue tab) and
// sendDailyDigest() (the morning email), so the two never drift apart.
function getOverdueRaw_() {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const out = [];

  for (let i = 1; i < data.length; i++) {
    const pn = String(data[i][COL.PARENT_NAME - 1] || "").trim();
    if (!pn) continue;

    const st = String(data[i][COL.STATUS - 1] || "");

    // FIX: Skip Converted and Lost — they are closed leads
    if (!ACTIVE_STATUSES.includes(st)) continue;
    if (isSpamRow_(data[i])) continue;

    const nf = data[i][COL.NEXT_FOLLOWUP - 1];
    if (!nf) continue;

    const fd = new Date(nf);
    if (isNaN(fd.getTime())) continue;
    fd.setHours(0, 0, 0, 0);

    if (fd <= today) {
      const remarks = String(data[i][COL.REMARKS - 1] || "");
      const lastNote = remarks.split("\n").filter(Boolean).pop() || "";
      out.push({
        id: data[i][COL.ID - 1],
        parentName: pn,
        childName: String(data[i][COL.CHILD_NAME - 1] || ""),
        phone: String(data[i][COL.PHONE - 1] || ""),
        status: st,
        dueDate: fmt(fd),
        daysOverdue: Math.floor((today - fd) / 864e5),
        lastNote: lastNote.substring(0, 90),
      });
    }
  }

  return out.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

function getOverdue() {
  try {
    return { ok: true, leads: getOverdueRaw_() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── DAILY 8 AM SUMMARY EMAIL ─────────────────────────────────
// To turn the automatic morning email ON: in the Script Editor, pick
// "createDailyDigestTrigger" from the function dropdown and click Run,
// ONE time. That's it — it'll then fire on its own every day around
// 8 AM without any further action. Re-running it is safe (it replaces
// the old schedule instead of creating a duplicate).
// Who gets the 8 am summary: Script Properties > DIGEST_EMAIL (comma-separate several people).
// Falls back to the script owner. Kept out of this file because the repo is public.
const DIGEST_TRIGGER_FN = "sendDailyDigest";
function digestRecipients_() {
  return PropertiesService.getScriptProperties().getProperty("DIGEST_EMAIL") || Session.getEffectiveUser().getEmail();
}

function digestEsc_(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}

function digestTable_(headers, rows) {
  const td = 'style="padding:8px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top"';
  return (
    '<table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">' +
    '<tr style="background:#f0f3fa;text-align:left">' +
    headers.map(function (h) { return '<th style="padding:8px 12px">' + h + "</th>"; }).join("") +
    "</tr>" +
    rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td " + td + ">" + c + "</td>"; }).join("") + "</tr>"; }).join("") +
    "</table>"
  );
}

// New leads whose Date of Inquiry is yesterday or today (the email goes out at 8 am).
function getNewLeadsForDigest_() {
  const data = getSheet().getDataRange().getValues();
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 1);
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const d = data[i][COL.DATE_INQUIRY - 1];
    if (!(d instanceof Date) || d < since || !String(data[i][COL.PARENT_NAME - 1] || data[i][COL.PHONE - 1] || "").trim()) continue;
    if (isSpamRow_(data[i])) continue;
    out.push(rowToLead(data[i]));
  }
  return out;
}

// Morning summary: new leads, parents waiting on WhatsApp, overdue follow-ups.
function sendDailyDigest() {
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, "dd MMM yyyy");
  const newLeads = getNewLeadsForDigest_();
  const overdue = getOverdueRaw_();

  let waiting = [];
  let inboxError = "";
  try {
    const inbox = getCrmInbox();
    if (inbox.ok) {
      waiting = inbox.chats.filter(function (c) { return c.unreadCount > 0 && c.lastRole === "user"; });
    } else {
      inboxError = inbox.error;
    }
  } catch (e) {
    inboxError = e.message;
  }

  const h2 = function (t) { return '<h3 style="color:#4361ee;margin:20px 0 6px">' + t + "</h3>"; };
  let html = '<div style="font-family:sans-serif;color:#0f172a;max-width:680px">' +
    '<h2 style="margin-bottom:2px">GLO CRM: good morning</h2>' +
    '<p style="color:#475569;margin-top:0">' + today + "</p>";

  html += h2("🆕 New leads since yesterday (" + newLeads.length + ")");
  html += newLeads.length
    ? digestTable_(["Lead", "Phone", "Source", "Status"], newLeads.map(function (l) {
        return ["#" + l.id + " " + digestEsc_(l.parentName) + (l.childName ? " / " + digestEsc_(l.childName) : ""), digestEsc_(l.phone), digestEsc_(l.source || "—"), digestEsc_(l.status)];
      }))
    : "<p>No new leads.</p>";

  html += h2("💬 Parents waiting for a reply on WhatsApp (" + waiting.length + ")");
  html += inboxError
    ? '<p style="color:#b45309">Could not load WhatsApp chats: ' + digestEsc_(inboxError) + "</p>"
    : waiting.length
      ? digestTable_(["Parent", "Last message", "Unread"], waiting.map(function (c) {
          return [digestEsc_(c.parentName || c.phone) + (c.lead ? " (#" + c.lead.id + ")" : " (not in CRM)"), digestEsc_(String(c.lastMessage || "").slice(0, 120)), String(c.unreadCount)];
        }))
      : "<p>Nobody is waiting.</p>";

  html += h2("⏰ Overdue follow-ups (" + overdue.length + ")");
  html += overdue.length
    ? digestTable_(["Overdue", "Lead", "Phone", "Status", "Last note"], overdue.map(function (l) {
        const color = l.daysOverdue === 0 ? "#d97706" : "#dc2626";
        return ['<b style="color:' + color + '">' + (l.daysOverdue === 0 ? "Today" : l.daysOverdue + "d") + "</b>", digestEsc_(l.parentName) + (l.childName ? " / " + digestEsc_(l.childName) : ""), digestEsc_(l.phone), digestEsc_(l.status), digestEsc_(l.lastNote || "—")];
      }))
    : "<p>🎉 Nothing overdue. Every active lead is on track.</p>";

  html += "</div>";

  MailApp.sendEmail({
    to: digestRecipients_(),
    subject: "GLO CRM " + today + ": " + newLeads.length + " new, " + waiting.length + " waiting on WhatsApp, " + overdue.length + " overdue",
    htmlBody: html,
  });
}

// Run this ONCE from the Script Editor to schedule the digest.
// Safe to re-run — it clears any previous schedule for this function
// first, so you'll never end up with two daily emails firing.
function createDailyDigestTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === DIGEST_TRIGGER_FN) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger(DIGEST_TRIGGER_FN).timeBased().atHour(8).everyDays(1).create();
  Logger.log(
    "Daily digest scheduled — you'll get an email every morning around 8 AM " +
      "listing any overdue follow-ups, sent to " + digestRecipients_() + ".",
  );
}

// ── CONVERSION TREND (last 6 months) ────────────────────────────
// NOTE: the sheet doesn't track a separate "date converted" field, so a
// Converted lead's month is approximated using its Last Contact date
// (the closest signal available) — good enough for a trend line, but
// worth knowing if a number looks off for a given month.
function getConversionTrend() {
  try {
    const sheet = getSheet();
    const data = sheet.getDataRange().getValues();
    const now = new Date();

    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        key: d.getFullYear() + "-" + d.getMonth(),
        label: Utilities.formatDate(d, Session.getScriptTimeZone(), "MMM yyyy"),
        inquiries: 0,
        converted: 0,
      });
    }
    const idxByKey = {};
    months.forEach(function (m, i) {
      idxByKey[m.key] = i;
    });

    for (let i = 1; i < data.length; i++) {
      const pn = String(data[i][COL.PARENT_NAME - 1] || "").trim();
      if (!pn) continue;

      const dInq = data[i][COL.DATE_INQUIRY - 1];
      if (dInq) {
        const d = new Date(dInq);
        if (!isNaN(d.getTime())) {
          const key = d.getFullYear() + "-" + d.getMonth();
          if (idxByKey.hasOwnProperty(key)) months[idxByKey[key]].inquiries++;
        }
      }

      if (String(data[i][COL.STATUS - 1] || "") === "Converted") {
        const dLc = data[i][COL.LAST_CONTACT - 1];
        if (dLc) {
          const d = new Date(dLc);
          if (!isNaN(d.getTime())) {
            const key = d.getFullYear() + "-" + d.getMonth();
            if (idxByKey.hasOwnProperty(key)) months[idxByKey[key]].converted++;
          }
        }
      }
    }

    return { ok: true, months: months };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── DASHBOARD STATS ───────────────────────────────────────────
// FIX: Every lead counted in exactly one bucket; source uses safeSource()
function getStats() {
  try {
    const sheet = getSheet();
    const data = sheet.getDataRange().getValues();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const s = {
      total: 0,
      converted: 0,
      lost: 0,
      open: 0,
      waiting: 0,
      probable: 0,
      lessLikely: 0,
      other: 0,
      overdue: 0,
      dueToday: 0,
      bySource: {},
      convertedBySource: {},
      byStatus: {},
      byQuality: {},
      spam: 0,
    };

    for (let i = 1; i < data.length; i++) {
      const pn = String(data[i][COL.PARENT_NAME - 1] || "").trim();
      if (!pn) continue;
      // Spam leads are kept in the sheet but left out of every count.
      if (isSpamRow_(data[i])) {
        s.spam++;
        continue;
      }
      s.total++;
      const q = String(data[i][COL.QUALITY - 1] || "").trim() || "Not checked";
      s.byQuality[q] = (s.byQuality[q] || 0) + 1;

      const st = String(data[i][COL.STATUS - 1] || "");
      // FIX: Every status maps to exactly one bucket
      switch (st) {
        case "Converted":
          s.converted++;
          break;
        case "Lost":
          s.lost++;
          break;
        case "Open":
          s.open++;
          break;
        case "Waiting":
          s.waiting++;
          break;
        case "Probable":
          s.probable++;
          break;
        case "Less Likely":
          s.lessLikely++;
          break;
        default:
          s.other++;
          break; // catches old statuses like "New","Contacted"
      }

      // FIX: Use safeSource() to prevent Date objects appearing as source labels
      const src = safeSource(data[i][COL.SOURCE - 1]);
      s.bySource[src] = (s.bySource[src] || 0) + 1; if (st === "Converted") s.convertedBySource[src] = (s.convertedBySource[src] || 0) + 1;

      // Overdue / due today — only active leads
      if (ACTIVE_STATUSES.includes(st)) {
        const nf = data[i][COL.NEXT_FOLLOWUP - 1];
        if (nf) {
          const fd = new Date(nf);
          if (!isNaN(fd.getTime())) {
            fd.setHours(0, 0, 0, 0);
            if (fd < today) s.overdue++;
            if (fd.getTime() === today.getTime()) s.dueToday++;
          }
        }
      }
    }

    return { ok: true, stats: s };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============================================================
//  ONE-TIME MIGRATION — run manually once from the Script Editor
//  (function dropdown at top → select migrateLegacyCRM → Run)
//
//  The old "CRM" tab has 16 columns with Source/Remarks/Address
//  duplicated at the end (cols 11-13 are mostly blank leftovers;
//  the real Source/Remarks/Address ended up in cols 14-16).
//  On top of that, ~15 rows that were hand-updated in 2026 have
//  an extra "Follow-up" marker in col I, which pushes Last Contact
//  into col J and Next Follow-up into col K for those rows only.
//
//  This function rebuilds a clean 13-column "CRM" sheet that
//  matches the COL mapping above. The original sheet is renamed
//  to "CRM_Legacy_Raw" and left completely untouched as a backup —
//  nothing is deleted. Any leftover/ambiguous values that don't
//  cleanly map anywhere are appended to Remarks in [brackets] so
//  no historical note is silently dropped.
// ============================================================
const MO_MAP = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function parseLegacyDate_(v) {
  if (!v) return "";
  if (v instanceof Date) return v;
  const s = String(v).trim();
  if (!s) return "";
  let m = s.match(/^(\d{1,2})[\-\/]([A-Za-z]{3})[\-\/](\d{4})$/); // 5-Jan-2024
  if (m) return new Date(+m[3], MO_MAP[m[2].toLowerCase()] || 0, +m[1]);
  m = s.match(/^(\d{1,2})[\-\/](\d{1,2})[\-\/](\d{2,4})$/); // 04-12-23 / 20-03-26 (dd-mm-yy)
  if (m) {
    let yr = +m[3];
    if (yr < 100) yr += 2000;
    return new Date(yr, +m[2] - 1, +m[1]);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : d;
}

function migrateLegacyCRM() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const src = ss.getSheetByName(SHEET_NAME);
  if (!src) throw new Error('Sheet "' + SHEET_NAME + '" not found.');
  if (ss.getSheetByName("CRM_Legacy_Raw")) {
    throw new Error(
      'Migration already run — "CRM_Legacy_Raw" backup already exists. Delete it first if you really want to re-run.',
    );
  }

  const data = src.getDataRange().getValues();
  const rows = data.slice(1); // skip header row

  // 1. Preserve the raw sheet untouched, just rename it
  src.setName("CRM_Legacy_Raw");

  // 2. Create the clean sheet the rest of the app expects
  const clean = ss.insertSheet(SHEET_NAME, 0);
  const header = [
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
  clean.appendRow(header);
  clean.getRange(1, 1, 1, header.length).setBackground("#16213e").setFontColor("#fff").setFontWeight("bold");
  clean.setFrozenRows(1);

  const out = [];
  rows.forEach((r) => {
    const id = r[0];
    if (!id && !r[4]) return; // fully blank row — skip

    const dateInq = parseLegacyDate_(r[1]);
    const childName = r[2] || "";
    const classInt = r[3] || "";
    const parent = r[4] || "";
    const phone = r[5] || "";
    const age = r[6] || "";
    const status = r[7] || "";

    const touched2026 = String(r[8]).trim().toLowerCase() === "follow-up";
    let lastContactRaw, nextFollowupRaw;
    const extra = [];

    if (touched2026) {
      // shifted layout: I="Follow-up" marker, J=Last Contact, K=Next Follow-up, L=attempt count
      lastContactRaw = r[9];
      nextFollowupRaw = r[10];
      if (r[11]) extra.push("Contact attempts: " + r[11]);
    } else {
      // normal layout: J holds the one date this sheet ever tracked (last touched)
      lastContactRaw = r[9];
      nextFollowupRaw = "";
      if (r[10]) extra.push("Legacy note (col K): " + r[10]);
      if (r[11]) extra.push("Legacy note (col L): " + r[11]);
    }

    const lastContact = parseLegacyDate_(lastContactRaw);
    const nextFollowup = parseLegacyDate_(nextFollowupRaw);

    const source = r[13] || ""; // real Source lived in the duplicated column
    let remarks = r[14] || ""; // real Remarks lived in the duplicated column
    const address = r[15] || "";

    if (extra.length) remarks = (remarks ? remarks + "\n" : "") + "[" + extra.join("; ") + "]";

    out.push([
      id,
      dateInq,
      childName,
      classInt,
      parent,
      phone,
      age,
      status,
      lastContact,
      nextFollowup,
      source,
      remarks,
      address,
    ]);
  });

  if (out.length) {
    clean.getRange(2, 1, out.length, header.length).setValues(out);
    clean.getRange(2, COL.DATE_INQUIRY, out.length, 1).setNumberFormat("dd-MMM-yyyy");
    clean.getRange(2, COL.LAST_CONTACT, out.length, 1).setNumberFormat("dd-MMM-yyyy");
    clean.getRange(2, COL.NEXT_FOLLOWUP, out.length, 1).setNumberFormat("dd-MMM-yyyy");
  }

  SpreadsheetApp.getUi().alert(
    "Migration complete: " +
      out.length +
      ' leads copied into the new "CRM" sheet.\n\n' +
      'Your original data is untouched in the "CRM_Legacy_Raw" tab — nothing was deleted.\n' +
      "Any dates/notes that were ambiguous in the old layout were preserved as [bracketed] notes inside Remarks so you can review and clean them up manually if needed.",
  );
}

// ── WHATSAPP API SEND (Meta-approved templates, e.g. after a phone call or a school visit) ──
// Unlike logWaSend above (which just records that STAFF manually opened WhatsApp and sent a
// message themselves via wa.me), this ACTUALLY sends the message — through the GLO admissions
// bot's Render backend (POST /send-template), which calls Meta's Graph API using an approved
// WhatsApp message template. This works even OUTSIDE the normal 24-hour reply window, which a
// wa.me link cannot do once WhatsApp restricts free-form messages to that window.
// Backend URL and the optional shared secret are read from Script Properties (Project Settings
// > Script Properties) so nothing sensitive sits in this source file:
//   CRM_BACKEND_URL = https://aiadmissionofficer.onrender.com  (defaults to this if unset)
//   CRM_SEND_SECRET = only needed if the same value is also set as CRM_SEND_SECRET on Render
const CRM_TEMPLATES = {
  called: { name: "admission_call_followup_v1", language: "en" },
  visited: { name: "post_visit_followup", language: "en" },
};

function sendCrmWhatsAppTemplate(leadId, templateKey) {
  try {
    const tpl = CRM_TEMPLATES[templateKey];
    if (!tpl) return { ok: false, error: "Unknown template: " + templateKey };

    const sheet = getSheet();
    const rows = sheet.getDataRange().getValues();

    let targetRow = -1;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][COL.ID - 1]) === String(leadId)) {
        targetRow = i + 1;
        break;
      }
    }
    if (targetRow < 0) return { ok: false, error: "Lead ID not found" };

    const phone = String(rows[targetRow - 1][COL.PHONE - 1] || "").trim();
    if (!phone) return { ok: false, error: "No phone number on this lead" };

    const props = PropertiesService.getScriptProperties();
    const backendUrl = props.getProperty("CRM_BACKEND_URL") || "https://aiadmissionofficer.onrender.com";
    const secret = props.getProperty("CRM_SEND_SECRET");

    const payload = {
      phone: normalizePhoneForApi_(phone),
      templateName: tpl.name,
      languageCode: tpl.language,
      bodyVariables: [],
    };
    const options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      headers: secret ? { "x-api-key": secret } : {},
    };

    const res = UrlFetchApp.fetch(backendUrl + "/send-template", options);
    const code2 = res.getResponseCode();
    const body = res.getContentText();

    if (code2 < 200 || code2 >= 300) {
      return { ok: false, error: "Send failed (" + code2 + "): " + body };
    }

    const today = new Date();
    const dateStr = fmtLog(today);
    const existing = String(rows[targetRow - 1][COL.REMARKS - 1]).trim();
    const newEntry = "[" + dateStr + "] WhatsApp template sent (API): " + tpl.name;
    const updated = existing ? existing + "\n" + newEntry : newEntry;

    sheet.getRange(targetRow, COL.REMARKS).setValue(updated);
    sheet.getRange(targetRow, COL.LAST_CONTACT).setValue(today).setNumberFormat("dd-MMM-yyyy");

    const updatedRow = sheet.getRange(targetRow, 1, 1, 13).getValues()[0];
    return { ok: true, lead: rowToLead(updatedRow) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Indian mobile numbers only, same rule as Index.html's normalizePhone() — strip non-digits,
// keep the last 10, prepend country code 91. Kept as a separate helper here since this call
// happens entirely server-side, with no access to the client's normalizePhone().
function normalizePhoneForApi_(phone) {
  const digits = String(phone).replace(/\D/g, "");
  const last10 = digits.slice(-10);
  return "91" + last10;
}

// --- CRM CHAT VIEWER (view full AI/parent transcript + send a manual reply) --------------------
// Lets staff see the whole WhatsApp conversation for a lead and send a manual reply from the CRM
// itself. Unlike sendCrmWhatsAppTemplate above (approved Meta templates, works outside the
// 24-hour window), this sends a plain free-form message and only works within the live 24-hour
// reply window - exactly like a normal WhatsApp reply. Sending a manual message here also pauses
// the AI bot for that family (2 hours, set on the backend) so it doesn't talk over a human who
// just stepped in.

function getCrmConversation(phone) {
  try {
    const props = PropertiesService.getScriptProperties();
    const backendUrl = props.getProperty("CRM_BACKEND_URL") || "https://aiadmissionofficer.onrender.com";
    const secret = props.getProperty("CRM_SEND_SECRET");

    const options = {
      method: "get",
      muteHttpExceptions: true,
      headers: secret ? { "x-api-key": secret } : {},
    };

    const url = backendUrl + "/conversation?phone=" + encodeURIComponent(normalizePhoneForApi_(phone));
    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    const body = res.getContentText();

    if (code < 200 || code >= 300) {
      return { ok: false, error: "Load failed (" + code + "): " + body };
    }
    return JSON.parse(body);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function sendCrmManualMessage(leadId, phone, message) {
  try {
    if (!message || !String(message).trim()) {
      return { ok: false, error: "Message is empty" };
    }

    const props = PropertiesService.getScriptProperties();
    const backendUrl = props.getProperty("CRM_BACKEND_URL") || "https://aiadmissionofficer.onrender.com";
    const secret = props.getProperty("CRM_SEND_SECRET");

    const payload = {
      phone: normalizePhoneForApi_(phone),
      message: String(message).trim(),
      // pauseMinutes intentionally omitted - the backend's own default (120 min / 2 hours) applies
    };
    const options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      headers: secret ? { "x-api-key": secret } : {},
    };

    const res = UrlFetchApp.fetch(backendUrl + "/send-message", options);
    const code = res.getResponseCode();
    const body = res.getContentText();

    if (code < 200 || code >= 300) {
      return { ok: false, error: "Send failed (" + code + "): " + body };
    }

    // Log the manual send in the sheet's Remarks column, same pattern as sendCrmWhatsAppTemplate,
    // so staff see it on the CRM row without needing to reopen the chat viewer.
    if (leadId) {
      const sheet = getSheet();
      const rows = sheet.getDataRange().getValues();
      let targetRow = -1;
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][COL.ID - 1]) === String(leadId)) {
          targetRow = i + 1;
          break;
        }
      }
      if (targetRow !== -1) {
        const today = new Date();
        const dateStr = fmtLog(today);
        const existing = String(rows[targetRow - 1][COL.REMARKS - 1]).trim();
        const newEntry = "[" + dateStr + "] Manual WhatsApp reply sent from chat viewer";
        const updated = existing ? existing + "\n" + newEntry : newEntry;
        sheet.getRange(targetRow, COL.REMARKS).setValue(updated);
        sheet.getRange(targetRow, COL.LAST_CONTACT).setValue(today).setNumberFormat("dd-MMM-yyyy");
      }
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function authTestUrlFetch() {
  UrlFetchApp.fetch("https://www.google.com", { muteHttpExceptions: true });
  Logger.log("UrlFetchApp authorized OK");
}

// ── WHATSAPP INBOX (every chat with the bot, matched to CRM leads by phone) ──────────────────────
// Talks to the admissions bot's /api/inbox/* endpoints. The backend URL and CRM_SEND_SECRET come
// from Script Properties (same as the chat viewer above), so the key never reaches the browser.

function crmBackend_(method, path, payload) {
  const props = PropertiesService.getScriptProperties();
  const backendUrl = props.getProperty("CRM_BACKEND_URL") || "https://aiadmissionofficer.onrender.com";
  const secret = props.getProperty("CRM_SEND_SECRET");
  const options = {
    method: method,
    muteHttpExceptions: true,
    headers: secret ? { "x-api-key": secret } : {},
  };
  if (payload !== undefined) {
    options.contentType = "application/json";
    options.payload = JSON.stringify(payload);
  }
  const res = UrlFetchApp.fetch(backendUrl + path, options);
  const code = res.getResponseCode();
  const body = res.getContentText();
  let data = {};
  try {
    data = JSON.parse(body);
  } catch (e) {
    data = {};
  }
  if (code < 200 || code >= 300) {
    throw new Error((data && data.error) || "Bot server error (" + code + ")");
  }
  return data;
}

// Lead lookup by the last 10 digits of the phone number (same rule as checkDuplicatePhone).
function leadsByPhone_() {
  const data = getSheet().getDataRange().getValues();
  const map = {};
  for (let i = 1; i < data.length; i++) {
    const key = normalizePhone_(data[i][COL.PHONE - 1]);
    if (!key) continue;
    // Keep the most recent lead for a number if there are duplicates.
    map[key] = rowToLead(data[i]);
  }
  return map;
}

function getCrmInbox() {
  try {
    const r = crmBackend_("get", "/api/inbox/conversations?limit=300");
    const leads = leadsByPhone_();
    let totalUnread = 0;
    const chats = (r.conversations || []).map(function (c) {
      const lead = leads[normalizePhone_(c.phone)] || null;
      totalUnread += c.unreadCount || 0;
      return {
        phone: c.phone,
        parentName: c.parentName || (lead && lead.parentName) || "",
        childName: c.childName || (lead && lead.childName) || "",
        childAge: c.childAge || "",
        lastMessage: c.lastMessage,
        lastRole: c.lastRole,
        lastMessageAt: c.lastMessageAt,
        lastInboundAt: c.lastInboundAt,
        unreadCount: c.unreadCount || 0,
        pausedUntil: c.pausedUntil,
        needsCallAt: c.needsCallAt || null,
        needsCallReason: c.needsCallReason || null,
        lead: lead
          ? { id: lead.id, parentName: lead.parentName, childName: lead.childName, status: lead.status, classInt: lead.classInt, phone: lead.phone }
          : null,
      };
    });
    return { ok: true, chats: chats, totalUnread: totalUnread };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function markCrmChatRead(phone) {
  try {
    crmBackend_("post", "/api/inbox/conversations/" + encodeURIComponent(normalizePhoneForApi_(phone)) + "/read", {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// minutes > 0 pauses the bot's auto-replies for this parent; 0 resumes them.
function setCrmBotPause(phone, minutes) {
  try {
    const m = Math.max(0, Number(minutes) || 0);
    crmBackend_("post", "/api/inbox/conversations/" + encodeURIComponent(normalizePhoneForApi_(phone)) + "/pause", { minutes: m });
    return { ok: true, paused: m > 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Template send for a chat that has no CRM lead yet (sendCrmWhatsAppTemplate above needs a lead ID).
function sendCrmTemplateToPhone(phone, templateKey) {
  try {
    const tpl = CRM_TEMPLATES[templateKey];
    if (!tpl) return { ok: false, error: "Unknown template: " + templateKey };
    crmBackend_("post", "/send-template", {
      phone: normalizePhoneForApi_(phone),
      templateName: tpl.name,
      languageCode: tpl.language,
      bodyVariables: [],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// "Add as lead" from a WhatsApp chat: reuses addLead, but refuses if the number already has a lead.
function addLeadFromChat(data) {
  try {
    const key = normalizePhone_(data.phone);
    if (!key) return { ok: false, error: "This chat has no valid phone number" };
    if (leadsByPhone_()[key]) return { ok: false, error: "A lead with this number already exists" };
    return addLead({
      parentName: String(data.parentName || "").trim() || "WhatsApp parent",
      childName: data.childName || "",
      age: data.age || "",
      phone: key,
      status: "Open",
      source: "WhatsApp",
      remarks: "[" + fmtLog(new Date()) + "] Added from WhatsApp chat",
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── CALL-BACK ALERTS ─────────────────────────────────────────
// The bot flags a parent when they ask about fees or ask for a person (fees are only discussed on
// a call). This emails the DIGEST_EMAIL people about NEW flags, so nobody waits until tomorrow.
// Turn it on once: run createCallbackAlertTrigger from the Script Editor (safe to re-run).
const CALLBACK_TRIGGER_FN = "checkCallbackAlerts";

function checkCallbackAlerts() {
  const props = PropertiesService.getScriptProperties();
  const since = props.getProperty("CALLBACK_ALERTED_UNTIL") || "";
  const inbox = getCrmInbox();
  if (!inbox.ok) return;
  const fresh = inbox.chats.filter(function (c) { return c.needsCallAt && c.needsCallAt > since; });
  if (!fresh.length) return;
  const newest = fresh.reduce(function (m, c) { return c.needsCallAt > m ? c.needsCallAt : m; }, since);
  const lines = fresh.map(function (c) {
    return "<li><b>" + digestEsc_(c.parentName || c.phone) + "</b> (" + digestEsc_(c.phone) + ")" +
      (c.lead ? " · lead #" + c.lead.id : " · not in CRM yet") + " · " + digestEsc_(c.needsCallReason || "") +
      "<br><span style=\"color:#475569\">" + digestEsc_(String(c.lastMessage || "").slice(0, 160)) + "</span></li>";
  }).join("");
  MailApp.sendEmail({
    to: digestRecipients_(),
    subject: "📞 GLO: " + fresh.length + " parent" + (fresh.length > 1 ? "s" : "") + " waiting for a call back",
    htmlBody: "<div style=\"font-family:sans-serif\"><p>These parents asked on WhatsApp and the bot told them our team will call:</p><ul>" + lines +
      "</ul><p>Open the CRM → 💬 WhatsApp → 📞 Call back. The flag clears when you reply from the CRM.</p></div>",
  });
  props.setProperty("CALLBACK_ALERTED_UNTIL", newest);
}

function createCallbackAlertTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === CALLBACK_TRIGGER_FN) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger(CALLBACK_TRIGGER_FN).timeBased().everyMinutes(15).create();
  Logger.log("Call-back alerts on: checked every 15 minutes, emailed to " + digestRecipients_() + ".");
}

// ── FORM LEADS → CRM (website form + Google Ads lead forms) ──
// Two senders post to this web app's URL:
//  - Elementor's form "Webhook" action:  <web app URL>?key=<FORM_WEBHOOK_KEY>  (form fields)
//  - Google Ads lead form webhook:       <web app URL>, with <GOOGLE_LEAD_KEY> as the "Key" in
//    Google Ads. Google sends JSON and puts that key in the body as "google_key".
// Both keys live only in Script Properties. A known phone number gets a dated remark on its existing
// lead instead of a duplicate. Every new lead gets a lead check (Hot / Warm / Cold / Spam), and,
// when LEAD_WELCOME_TEMPLATE is set, a WhatsApp welcome so a reply can prove it's a real parent.
function doPost(e) {
  const out = function (obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  };
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = e && e.postData && e.postData.contents;
    let json = null;
    if (raw && /^\s*\{/.test(raw)) {
      try {
        json = JSON.parse(raw);
      } catch (err) {
        json = null;
      }
    }
    if (json && json.google_key !== undefined) {
      const gkey = props.getProperty("GOOGLE_LEAD_KEY");
      if (!gkey || String(json.google_key) !== gkey) return out({ ok: false, error: "unauthorised" });
      return out(saveFormLead_(parseGoogleLead_(json)));
    }

    const expected = props.getProperty("FORM_WEBHOOK_KEY");
    const p = (e && e.parameter) || {};
    if (!expected || p.key !== expected) return out({ ok: false, error: "unauthorised" });
    return out(saveFormLead_(parseWebsiteForm_(p)));
  } catch (err) {
    return out({ ok: false, error: err.message });
  }
}

function parseWebsiteForm_(p) {
  const pick = function (re) {
    for (const k in p) {
      if (k === "key" || k === "form_id" || k === "form_name") continue;
      if (re.test(k) && String(p[k]).trim()) return String(p[k]).trim();
    }
    return "";
  };
  let phone = pick(/phone|mobile|whats|contact.?no|number/i);
  if (!normalizePhone_(phone)) {
    // Some forms label the phone field oddly; fall back to any value that looks like a number.
    for (const k in p) if (k !== "key" && normalizePhone_(p[k])) { phone = p[k]; break; }
  }
  return {
    kind: "Website form",
    source: "Website",
    parentName: pick(/^(your )?name|parent|full.?name/i) || pick(/name/i),
    childName: pick(/child'?s?.?name|kid|ward/i),
    childAge: pick(/(^|[^a-z])age\b|dob|birth|how old/i),
    phone: phone,
    email: pick(/e-?mail/i),
    area: pick(/address|city|area|locality|pin|zip/i),
    message: pick(/message|query|comment|enquiry|inquiry|question/i),
    honeypot: pick(/honeypot|hp_|leave.?blank|website_url/i),
    page: String(p.form_name || p.referer_title || p.page_url || ""),
  };
}

// Google Ads lead form webhook body: { lead_id, user_column_data: [{ column_id, column_name,
// string_value }], campaign_id, gcl_id, is_test, google_key, ... }. Standard questions have fixed
// column_ids (FULL_NAME, PHONE_NUMBER, EMAIL, CITY, POSTAL_CODE...); custom questions are matched
// by their question text.
function parseGoogleLead_(body) {
  const cols = body.user_column_data || [];
  const byId = {};
  const extras = [];
  let childAge = "";
  let childName = "";
  cols.forEach(function (c) {
    const id = String(c.column_id || "").toUpperCase();
    const label = String(c.column_name || id);
    const v = String(c.string_value || "").trim();
    if (!v) return;
    if (/^(FULL_NAME|FIRST_NAME|LAST_NAME|PHONE_NUMBER|EMAIL|WORK_EMAIL|WORK_PHONE|CITY|POSTAL_CODE|REGION|STREET_ADDRESS|COUNTRY)$/.test(id)) {
      byId[id] = v;
    } else if (/age|dob|birth|how old/i.test(label)) {
      childAge = v;
    } else if (/child|kid|ward|son|daughter/i.test(label)) {
      childName = v;
    } else {
      extras.push(label + ": " + v);
    }
  });
  const name = byId.FULL_NAME || [byId.FIRST_NAME, byId.LAST_NAME].filter(Boolean).join(" ");
  return {
    kind: "Google Ads lead form" + (body.is_test ? " (TEST from Google, delete me)" : ""),
    source: "Google Ads",
    parentName: name,
    childName: childName,
    childAge: childAge,
    phone: byId.PHONE_NUMBER || byId.WORK_PHONE || "",
    email: byId.EMAIL || byId.WORK_EMAIL || "",
    area: [byId.STREET_ADDRESS, byId.CITY, byId.REGION, byId.POSTAL_CODE].filter(Boolean).join(", "),
    message: extras.join(" · "),
    honeypot: "",
    page: body.campaign_id ? "campaign " + body.campaign_id : "",
  };
}

function saveFormLead_(f) {
  const phone = normalizePhone_(f.phone);
  if (!phone && !f.email) return { ok: false, error: "No phone or email in the form" };
  const check = scoreLead_({
    phone: f.phone,
    name: f.parentName,
    email: f.email,
    childAge: f.childAge,
    area: f.area,
    honeypot: f.honeypot,
  });
  const note = "[" + fmtLog(new Date()) + "] " + f.kind + (f.page ? " (" + f.page + ")" : "") + ": " +
    [f.message, f.childAge ? "Child's age: " + f.childAge : "", f.area ? "Area: " + f.area : "", f.email ? "Email: " + f.email : ""]
      .filter(String).join(" · ") +
    " · Lead check: " + check.quality + (check.reasons.length ? " (" + check.reasons.join(", ") + ")" : "");

  if (phone) {
    const existing = leadsByPhone_()[phone];
    if (existing) {
      const sheet = getSheet();
      const rows = sheet.getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][COL.ID - 1]) === String(existing.id)) {
          const old = String(rows[i][COL.REMARKS - 1] || "").trim();
          sheet.getRange(i + 1, COL.REMARKS).setValue(old ? old + "\n" + note : note);
          sheet.getRange(i + 1, COL.LAST_CONTACT).setValue(new Date()).setNumberFormat("dd-MMM-yyyy");
          // Same rule as the bot: only a blank label is filled; Hot / Cold / Spam already set stays.
          if (!String(rows[i][COL.QUALITY - 1] || "").trim()) {
            sheet.getRange(i + 1, COL.QUALITY).setValue(check.quality);
            ensureQualityHeader_(sheet);
          }
          return { ok: true, id: existing.id, existing: true, quality: check.quality };
        }
      }
    }
  }
  const res = addLead({
    parentName: f.parentName || (f.source === "Google Ads" ? "Google Ads enquiry" : "Website enquiry"),
    childName: f.childName,
    age: f.childAge,
    phone: phone || "",
    status: "Open",
    source: f.source,
    remarks: note,
    address: f.area,
    quality: check.quality,
  });
  if (res.ok && phone && check.quality !== "Spam") res.welcome = sendLeadWelcome_(phone, f.parentName);
  res.quality = check.quality;
  return res;
}

// Kept for anything still calling the old name.
function saveWebsiteEnquiry_(f) {
  f.kind = f.kind || "Website form";
  f.source = f.source || "Website";
  return saveFormLead_(f);
}

// WhatsApp welcome to a new form lead, through the bot (POST /send-template). The template is set
// in Script Properties: LEAD_WELCOME_TEMPLATE (an approved template whose body has one {{1}} for
// the parent's first name) and optionally LEAD_WELCOME_LANG (default "en"). pauseMinutes 0 keeps
// the bot answering, so it can reply when the parent writes back. Never throws.
function sendLeadWelcome_(phone10, parentName) {
  try {
    const props = PropertiesService.getScriptProperties();
    const template = props.getProperty("LEAD_WELCOME_TEMPLATE");
    if (!template) return "off";
    const first = String(parentName || "").trim().split(/\s+/)[0] || "there";
    crmBackend_("post", "/send-template", {
      phone: normalizePhoneForApi_(phone10),
      templateName: template,
      languageCode: props.getProperty("LEAD_WELCOME_LANG") || "en",
      bodyVariables: [first],
      pauseMinutes: 0,
    });
    return "sent";
  } catch (err) {
    Logger.log("Lead welcome failed: " + err.message);
    return "failed";
  }
}

// ── LEAD CHECK (Hot / Warm / Cold / Spam) ────────────────────
// Same rules as the bot's src/leadQuality.ts; keep the two in step.
//   Spam  junk or invalid phone, junk name, throwaway email, spam-trap field filled, no contact.
//         (Not applied to a parent who messaged on WhatsApp: WhatsApp has proved the number.)
//   Cold  child's age outside 1 to 6.5 years, or a PIN code outside 784xxx (Sonitpur).
//   Hot   the parent has written to us on WhatsApp (the bot sets this when they do).
//   Warm  everything else.
function isSpamRow_(row) {
  return String(row[COL.QUALITY - 1] || "").trim() === "Spam";
}

function ensureQualityHeader_(sheet) {
  const cell = sheet.getRange(1, COL.QUALITY);
  if (!String(cell.getValue() || "").trim()) cell.setValue("Quality");
}

function indianMobile_(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.length > 10 && /^(91|0)/.test(d)) d = d.slice(-10);
  return /^[6-9]\d{9}$/.test(d) ? d : "";
}

const LEAD_JUNK_NUMBERS = ["1234567890", "9876543210", "0123456789", "9123456789", "9999988888", "9988776655"];
const LEAD_JUNK_NAMES = /^(test|testing|tester|asdf\w*|qwerty|abc|abcd|xyz|na|n\/a|none|null|nil|fake|demo|sample|hello|hi|hii|ok|aaa+|xxx+|zzz+|sdf\w*)$/i;
const LEAD_THROWAWAY_EMAIL = /@(mailinator|guerrillamail|sharklasers|10minutemail|tempmail|temp-mail|yopmail|trashmail|getnada|dispostable|maildrop|fakeinbox|throwawaymail)\./i;
const LEAD_LOCAL_AREA = /tezpur|sonitpur|dhekiajuli|balipara|rangapara|misamari|biswanath|jamugurihat|bihaguri/i;

function isJunkName_(name) {
  const n = String(name || "").trim();
  if (!n) return false;
  if (!/[A-Za-zऀ-৿]/.test(n)) return true; // no letters (English, Hindi or Assamese)
  if (LEAD_JUNK_NAMES.test(n)) return true;
  const letters = n.replace(/[^a-z]/gi, "");
  return letters.length >= 5 && !/[aeiouy]/i.test(letters);
}

function parseAgeYears_(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return null;
  const now = new Date();
  let m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/);
  if (m) {
    const born = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    if (!isNaN(born.getTime())) return (now - born) / (365.25 * 864e5);
  }
  m = t.match(/\b(20\d{2})\b/);
  if (m && Number(m[1]) <= now.getFullYear()) return now.getFullYear() - Number(m[1]);
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|y)\b\D*(\d+)\s*(?:months?|mons?|mths?|m)\b/);
  if (m) return Number(m[1]) + Number(m[2]) / 12;
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:months?|mons?|mths?|mos?)\b/);
  if (m) return Number(m[1]) / 12;
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|y)?\b/);
  if (m && Number(m[1]) <= 12) return Number(m[1]);
  return null;
}

function scoreLead_(f) {
  const spam = [];
  const cold = [];
  const good = [];
  if (!f.repliedOnWhatsApp) {
    const mobile = indianMobile_(f.phone);
    if (f.phone && !mobile) spam.push("phone is not a valid Indian mobile");
    else if (mobile && (/^(\d)\1{6,}/.test(mobile) || LEAD_JUNK_NUMBERS.indexOf(mobile) >= 0)) spam.push("phone looks made up");
    else if (mobile) good.push("valid mobile");
    if (!f.phone && !f.email) spam.push("no phone or email");
    if (isJunkName_(f.name)) spam.push('name looks fake ("' + String(f.name).trim() + '")');
    if (f.email && LEAD_THROWAWAY_EMAIL.test(f.email)) spam.push("throwaway email address");
    if (f.honeypot && String(f.honeypot).trim()) spam.push("spam-trap field was filled (a bot)");
  }
  if (spam.length) return { quality: "Spam", reasons: spam };

  const age = parseAgeYears_(f.childAge);
  if (age !== null) {
    const label = age < 2 ? Math.round(age * 12) + " months" : Math.round(age * 10) / 10 + " years";
    if (age < 1 || age > 6.5) cold.push("child is " + label + ", outside 1 to 6½ years");
    else good.push("child " + label + " fits");
  }
  const area = String(f.area || "");
  const pin = area.match(/\b(\d{6})\b/);
  if (pin && pin[1].indexOf("784") !== 0) cold.push("PIN " + pin[1] + " is outside Sonitpur");
  else if (pin || LEAD_LOCAL_AREA.test(area)) good.push("local area");
  if (cold.length) return { quality: "Cold", reasons: cold };

  if (f.repliedOnWhatsApp) return { quality: "Hot", reasons: ["messaged on WhatsApp"].concat(good) };
  return { quality: "Warm", reasons: good.length ? good : ["no reply on WhatsApp yet"] };
}

// Run once from the editor to check the rules on sample leads (see the log).
function testLeadCheck() {
  const cases = [
    [{ phone: "9999999999", name: "Rahul" }, "Spam"],
    [{ phone: "12345", name: "Rahul" }, "Spam"],
    [{ phone: "9864012345", name: "test" }, "Spam"],
    [{ phone: "9864012345", name: "Rahul", email: "a@mailinator.com" }, "Spam"],
    [{ phone: "9864012345", name: "Rahul", childAge: "3" }, "Warm"],
    [{ phone: "9864012345", name: "Rahul", childAge: "9 years" }, "Cold"],
    [{ phone: "9864012345", name: "Rahul", area: "Guwahati 781006" }, "Cold"],
    [{ phone: "+91 98640 12345", name: "Anita Bora", area: "Tezpur 784001", childAge: "18 months" }, "Warm"],
  ];
  let pass = 0;
  cases.forEach(function (c) {
    const got = scoreLead_(c[0]).quality;
    if (got === c[1]) pass++;
    else Logger.log("FAIL " + JSON.stringify(c[0]) + " -> " + got + ", expected " + c[1]);
  });
  const g = parseGoogleLead_({
    google_key: "x",
    is_test: true,
    user_column_data: [
      { column_id: "FULL_NAME", string_value: "Anita Bora" },
      { column_id: "PHONE_NUMBER", string_value: "+919864012345" },
      { column_id: "POSTAL_CODE", string_value: "784001" },
      { column_name: "What is your child's age?", column_id: "q1", string_value: "3 years" },
    ],
  });
  if (g.parentName === "Anita Bora" && g.childAge === "3 years" && normalizePhone_(g.phone) === "9864012345") pass++;
  else Logger.log("FAIL Google lead parse: " + JSON.stringify(g));
  Logger.log("Lead check: " + pass + "/" + (cases.length + 1) + " passed");
}
