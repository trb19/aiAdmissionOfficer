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
// G=Age, H=Status, I=LastContact, J=NextFollowup, K=Source, L=Remarks, M=Address
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
    ]);

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

// ── DAILY OVERDUE EMAIL DIGEST ─────────────────────────────────
// Change DIGEST_EMAIL below to whichever inbox should receive it — can
// be a comma-separated list for multiple people.
// To turn the automatic morning email ON: in the Script Editor, pick
// "createDailyDigestTrigger" from the function dropdown and click Run,
// ONE time. That's it — it'll then fire on its own every day around
// 8 AM without any further action. Re-running it is safe (it replaces
// the old schedule instead of creating a duplicate).
const DIGEST_EMAIL = "cool.trb@gmail.com";
const DIGEST_TRIGGER_FN = "sendDailyDigest";

function sendDailyDigest() {
  const leads = getOverdueRaw_();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd MMM yyyy");

  if (!leads.length) {
    MailApp.sendEmail({
      to: DIGEST_EMAIL,
      subject: "GLO CRM — No overdue follow-ups today (" + today + ")",
      htmlBody:
        '<div style="font-family:sans-serif;color:#0f172a">' +
        "🎉 Nothing overdue today — every active lead is on track.</div>",
    });
    return;
  }

  let rows = "";
  leads.forEach(function (l) {
    const dayColor = l.daysOverdue === 0 ? "#d97706" : "#dc2626";
    rows +=
      "<tr>" +
      '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:700;color:' +
      dayColor +
      '">' +
      (l.daysOverdue === 0 ? "Today" : l.daysOverdue + "d") +
      "</td>" +
      '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">' +
      l.parentName +
      (l.childName ? " / " + l.childName : "") +
      "</td>" +
      '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">' +
      l.phone +
      "</td>" +
      '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">' +
      l.status +
      "</td>" +
      '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#475569">' +
      (l.lastNote || "—") +
      "</td>" +
      "</tr>";
  });

  const html =
    '<div style="font-family:sans-serif;color:#0f172a;max-width:640px">' +
    '<h2 style="color:#4361ee;margin-bottom:4px">GLO CRM — Overdue Follow-ups</h2>' +
    '<p style="color:#475569;margin-top:0">' +
    leads.length +
    " lead" +
    (leads.length !== 1 ? "s" : "") +
    " need a follow-up as of " +
    today +
    ".</p>" +
    '<table style="border-collapse:collapse;width:100%;font-size:13px">' +
    '<tr style="background:#f0f3fa;text-align:left">' +
    '<th style="padding:8px 12px">Overdue</th><th style="padding:8px 12px">Lead</th>' +
    '<th style="padding:8px 12px">Phone</th><th style="padding:8px 12px">Status</th>' +
    '<th style="padding:8px 12px">Last Note</th></tr>' +
    rows +
    "</table>" +
    "</div>";

  MailApp.sendEmail({
    to: DIGEST_EMAIL,
    subject:
      "GLO CRM — " +
      leads.length +
      " overdue follow-up" +
      (leads.length !== 1 ? "s" : "") +
      " (" +
      today +
      ")",
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
  SpreadsheetApp.getUi().alert(
    "Daily digest scheduled — you'll get an email every morning around 8 AM " +
      "listing any overdue follow-ups, sent to " +
      DIGEST_EMAIL +
      ".",
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
      byStatus: {},
    };

    for (let i = 1; i < data.length; i++) {
      const pn = String(data[i][COL.PARENT_NAME - 1] || "").trim();
      if (!pn) continue;
      s.total++;

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
      s.bySource[src] = (s.bySource[src] || 0) + 1;

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
