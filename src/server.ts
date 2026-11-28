import express from "express";
import path from "node:path";
import { config } from "./config.js";
import {
  extractInboundMessages,
  extractInboundAttachments,
  sendWhatsAppText,
  sendWhatsAppDocument,
  isBrochureRequest,
  sendWhatsAppTemplate,
  type InboundMessage,
} from "./whatsapp.js";
import {
  classifyMessage,
  feeRedirectReply,
  humanHandoffReply,
  generateReply,
  summarizeConversation,
  extractChildInfo,
  needsIntake,
  intakeAskSuffix,
  fixGrammar, topicQuestions,
} from "./ai.js";
import { matchFaq } from "./faq.js";
import { logEnquiry, upsertConversationSummary, upsertCrmLead, formatIstDateTime, formatCrmDate } from "./sheets.js";
import { extractLeadgenEvents, fetchMetaLead } from "./metaLeads.js";
import { parseWebsiteForm, parseGoogleLead, keyMatches, type FormLead } from "./formLeads.js";
import { scoreLead, describeLeadCheck, indianMobile } from "./leadQuality.js";
import { sendOfficeDigest, startDigestTimer } from "./officeDigest.js";
import {
  getRecentHistory,
  getFullConversation,
  saveMessage,
  getFamilyProfile,
  upsertFamilyProfile,
  incrementIntakeAttempts,
  getActiveFaqEntries,
  isBotPaused,
  pauseBot,
  listConversations,
  markConversationRead,
  flagNeedsCall,
} from "./db.js";

const app = express();
app.use(express.json());

// Simple in-memory dedup of message IDs. Meta retries webhook deliveries, and two deliveries of
// the same message must never produce two replies. This is process-memory only - fine for a
// single Phase 0 instance, but the moment there's more than one instance or a restart mid-traffic,
// this needs to move to a real store (a small Postgres/Redis table keyed by message ID). That's a
// deliberate, documented Phase 1 upgrade, not an oversight.
const seenMessageIds = new Set<string>();

// Per-phone lock so two messages from the SAME parent arriving close together (a fast follow-up
// text, or Meta delivering them a few seconds apart) never get processed concurrently. Without
// this, two overlapping calls can each read "no CRM/Conversations row for this phone yet" before
// either has finished writing theirs - producing two rows for one person (root-caused 15 Sept
// 2026: Aditya, 919444610876, got duplicated in both tabs because his first two messages landed
// 7 seconds apart). A phone's queue is a promise chain: each new message for that phone waits for
// the previous one to finish (success or failure) before it starts. Messages from DIFFERENT
// phones still run fully in parallel - this only serializes a single family's own messages.
// Same documented-risk category as seenMessageIds above: process-memory only, and the map grows
// for as long as the process runs (an entry per phone number ever seen, not per message) - fine
// at Phase 0 volume, a Phase 1 item to revisit if the number of distinct families gets large.
const phoneQueues = new Map<string, Promise<void>>();

function runSerializedByPhone(phone: string, task: () => Promise<void>): Promise<void> {
  const previous = phoneQueues.get(phone) ?? Promise.resolve();
  // Chain onto the previous task regardless of whether it succeeded or failed, so one bad message
  // can't wedge every later message from that phone forever.
  const next = previous.then(task, task);
  // What's stored is just "has the queue caught up" - never rejects, so the NEXT message's chain
  // isn't torn down by an error two messages back.
  phoneQueues.set(
    phone,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

// Website enquiry forms: Elementor's "Webhook" action posts the form fields (url-encoded) to
// /form-lead?key=<FORM_WEBHOOK_KEY>. Answered right away so the visitor's form never waits on the
// sheet; the lead is saved in the background. See src/formLeads.ts.
app.post("/form-lead", express.urlencoded({ extended: true }), (req, res) => {
  if (!keyMatches(req.query.key, config.formLeads.websiteKey)) {
    res.status(401).json({ ok: false, error: "unauthorised" });
    return;
  }
  const lead = parseWebsiteForm((req.body ?? {}) as Record<string, unknown>);
  res.status(200).json({ ok: true });
  void saveFormLead(lead).catch((err) => console.error("Error saving website form lead:", err));
});

// Google Ads lead form assets: Google posts JSON with the key from Google Ads in "google_key".
app.post("/google-lead", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!keyMatches(body.google_key, config.formLeads.googleKey)) {
    res.status(401).json({ ok: false, error: "unauthorised" });
    return;
  }
  const lead = parseGoogleLead(body);
  res.status(200).json({ ok: true });
  void saveFormLead(lead).catch((err) => console.error("Error saving Google Ads lead:", err));
});

/** A website or Google Ads form lead: add or update the CRM lead with its lead check, remember the
 * names for the bot, and (when LEAD_WELCOME_TEMPLATE is set) greet the parent on WhatsApp. */
async function saveFormLead(lead: FormLead): Promise<void> {
  const mobile = indianMobile(lead.phone);
  const waPhone = mobile ? `91${mobile}` : lead.phone.replace(/\D/g, "");
  if (!waPhone && !lead.email) {
    console.warn(`${lead.kind} skipped: no phone or email`);
    return;
  }
  const check = scoreLead({
    phone: lead.phone,
    name: lead.parentName,
    email: lead.email,
    childAge: lead.childAge,
    area: lead.area,
    honeypot: lead.honeypot,
    message: lead.message,
  });
  if (check.drop) {
    // A bot or a sales pitch: keep it out of the CRM, but leave a trace in the Render log.
    console.warn(`${lead.kind} dropped as spam (${check.reasons.join(", ")}): ${waPhone || lead.email}`);
    return;
  }
  const details = [
    lead.message,
    lead.childAge ? `Child's age: ${lead.childAge}` : "",
    lead.area ? `Area: ${lead.area}` : "",
    lead.email ? `Email: ${lead.email}` : "",
  ].filter(Boolean);
  const note =
    `[${formatCrmDate(new Date()).replace(/-/g, " ")}] ${lead.kind}${lead.page ? ` (${lead.page})` : ""}` +
    `${details.length ? ": " + details.join(" · ") : ""} · ${describeLeadCheck(check)}`;

  await runSerializedByPhone(waPhone || lead.email, async () => {
    if (waPhone && check.quality !== "Spam") {
      await upsertFamilyProfile(waPhone, {
        ...(lead.parentName ? { parentName: lead.parentName } : {}),
        ...(lead.childName ? { childName: lead.childName } : {}),
        ...(lead.childAge ? { childAge: lead.childAge } : {}),
      });
    }
    await upsertCrmLead({
      phone: waPhone,
      parentName: lead.parentName || `${lead.source} enquiry`,
      childName: lead.childName,
      childAge: lead.childAge,
      address: lead.area || undefined,
      source: lead.source,
      note,
      quality: check.quality,
    });

    if (config.leadWelcome.template && mobile && check.quality !== "Spam" && !lead.isTest) {
      const firstName = lead.parentName.trim().split(/\s+/)[0] || "there";
      try {
        await sendWhatsAppTemplate(waPhone, config.leadWelcome.template, config.leadWelcome.language, [firstName]);
        await saveMessage(waPhone, "model", `[Welcome template sent: ${config.leadWelcome.template}]`);
      } catch (err) {
        console.error("Lead welcome template failed:", err);
      }
    }
  });
}

// Meta's webhook verification handshake - it hits this with a challenge value that must be echoed
// back exactly, but only if the verify token matches what's configured in Meta's dashboard.
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", (req, res) => {
  // Acknowledge immediately - Meta expects a fast 200 and will retry aggressively if it doesn't
  // get one. All the real work happens after responding, not before.
  res.sendStatus(200);

  void handleWebhookEvent(req.body).catch((err) => {
    console.error("Error handling webhook event:", err);
  });
});

async function handleWebhookEvent(body: unknown): Promise<void> {
  // Facebook Page webhooks (Meta lead-form ads) arrive on this same URL with object "page".
  for (const event of extractLeadgenEvents(body)) {
    const key = `leadgen:${event.leadgenId}`;
    if (seenMessageIds.has(key)) continue;
    seenMessageIds.add(key);
    void processMetaLead(event.leadgenId).catch((err) => {
      console.error("Error processing Meta lead:", err);
    });
  }

  const messages = extractInboundMessages(body);

  // Photos, voice notes, documents, button taps etc. - the bot doesn't answer these, but they're
  // saved into the conversation so staff can see them in /inbox (previously they vanished).
  for (const attachment of extractInboundAttachments(body)) {
    if (seenMessageIds.has(attachment.messageId)) continue;
    seenMessageIds.add(attachment.messageId);
    void runSerializedByPhone(attachment.from, async () => {
      if (attachment.parentName) {
        await upsertFamilyProfile(attachment.from, { parentName: attachment.parentName });
      }
      await saveMessage(attachment.from, "user", attachment.label);
    }).catch((err) => {
      console.error("Error saving attachment message:", err);
    });
  }

  for (const message of messages) {
    if (seenMessageIds.has(message.messageId)) {
      continue; // duplicate delivery of a message we already handled
    }
    seenMessageIds.add(message.messageId);

    // Queued per phone (see phoneQueues above) rather than awaited directly here - this still lets
    // messages from different families process in parallel, it just stops this one family's
    // messages from racing each other's Sheets/DB writes.
    void runSerializedByPhone(message.from, () => processMessage(message)).catch((err) => {
      console.error("Error processing message:", err);
    });
  }
}

/** A Meta lead-form lead: fetch the answers, add or update the CRM lead with its lead check, and
 * (when LEAD_WELCOME_TEMPLATE is set) greet the parent on WhatsApp so a reply can prove the lead. */
async function processMetaLead(leadgenId: string): Promise<void> {
  if (!config.meta.pageAccessToken) {
    console.warn(`Meta lead ${leadgenId} ignored: META_PAGE_ACCESS_TOKEN is not set`);
    return;
  }
  const lead = await fetchMetaLead(leadgenId);
  const mobile = indianMobile(lead.phone);
  const waPhone = mobile ? `91${mobile}` : (lead.phone ?? "").replace(/\D/g, "");
  if (!waPhone && !lead.email) {
    console.warn(`Meta lead ${leadgenId} has no phone or email; skipped`);
    return;
  }
  const area = [lead.city, lead.zip].filter(Boolean).join(" ");
  const check = scoreLead({ phone: lead.phone, name: lead.name, email: lead.email, childAge: lead.childAge, area });
  const where = [lead.campaignName, lead.adName].filter(Boolean).join(" / ");
  const details = [
    lead.email ? `Email: ${lead.email}` : "",
    area ? `Area: ${area}` : "",
    lead.childAge ? `Child's age: ${lead.childAge}` : "",
    ...lead.extras,
  ].filter(Boolean);
  const note =
    `[${formatCrmDate(new Date()).replace(/-/g, " ")}] ${lead.platform} lead form${where ? ` (${where})` : ""}` +
    `${details.length ? ": " + details.join(" · ") : ""} · ${describeLeadCheck(check)}`;

  await runSerializedByPhone(waPhone || leadgenId, async () => {
    if (waPhone) {
      await upsertFamilyProfile(waPhone, {
        ...(lead.name ? { parentName: lead.name } : {}),
        ...(lead.childName ? { childName: lead.childName } : {}),
        ...(lead.childAge ? { childAge: lead.childAge } : {}),
      });
    }
    await upsertCrmLead({
      phone: waPhone,
      parentName: lead.name,
      childName: lead.childName,
      childAge: lead.childAge,
      address: area || undefined,
      source: lead.platform === "Instagram" ? "Insta Ads" : "Facebook Ads",
      note,
      quality: check.quality,
    });

    if (config.leadWelcome.template && mobile && check.quality !== "Spam") {
      const firstName = (lead.name ?? "").trim().split(/\s+/)[0] || "there";
      try {
        await sendWhatsAppTemplate(waPhone, config.leadWelcome.template, config.leadWelcome.language, [firstName]);
        await saveMessage(waPhone, "model", `[Welcome template sent: ${config.leadWelcome.template}]`);
      } catch (err) {
        console.error("Lead welcome template failed:", err);
      }
    }
  });
}

async function processMessage(message: InboundMessage): Promise<void> {
  // The WhatsApp display name arrives on every message but only needs to be stored once - safe
  // to call every time regardless, upsertFamilyProfile leaves other fields untouched.
  if (message.parentName) {
    await upsertFamilyProfile(message.from, { parentName: message.parentName });
  }

  // Pulled once per message and reused for both the reply and the running summary below - this
  // is the bot's actual memory of the conversation so far (see src/db.ts), separate from the
  // Google Sheet's human-facing log.
  const history = await getRecentHistory(message.from);
  const profile = await getFamilyProfile(message.from);

  if (isBotPaused(profile)) {
    // A staff member sent a manual reply from the CRM's chat viewer recently (see POST
    // /send-message below) - stay quiet for this family until that pause expires instead of
    // talking over them. Still log the inbound message and keep the CRM/sheets in sync, just
    // without generating or sending an auto-reply.
    await saveMessage(message.from, "user", message.text);
    await logEnquiry({
      timestamp: formatIstDateTime(new Date(Number(message.timestamp) * 1000)),
      phone: message.from,
      question: message.text,
      aiAnswer: "(bot paused - awaiting staff reply)",
      classification: "HUMAN_HANDLING",
    });
    const fullHistory = [...history, { role: "user" as const, content: message.text }];
    const summary = await summarizeConversation(fullHistory);
    await upsertCrmLead({
      phone: message.from,
      parentName: message.parentName ?? profile.parentName ?? undefined,
      childName: profile.childName ?? undefined,
      childAge: profile.childAge ?? undefined,
      remarks: summary,
      quality: scoreLead({ phone: message.from, childAge: profile.childAge ?? undefined, repliedOnWhatsApp: true }).quality,
    });
    await upsertConversationSummary(message.from, summary, "HUMAN_HANDLING");
    return;
  }

  const classification = classifyMessage(message.text);

  // Whether THIS reply is allowed to ask for the child's name/age, decided once up front from
  // the profile as it stood before this turn - both feeRedirectReply and generateReply make the
  // same decision independently, so this is what tells us afterwards whether to count it as an
  // attempt (see MAX_INTAKE_ATTEMPTS in ai.ts).
  const askingForIntake = needsIntake(profile);

  let reply: string;
  if (classification === "FEE_QUESTION") {
    reply = feeRedirectReply(profile);
    await flagNeedsCall(message.from, "Fees");
  } else if (classification === "HUMAN_REQUEST") {
    reply = humanHandoffReply(config.escalationPhone);
    await flagNeedsCall(message.from, "Wants to talk to a person");
  } else {
    // Check the pre-approved FAQ cache before spending a Gemini call - see src/faq.ts and the
    // faq_entries seed in src/db.ts. A hit answers instantly from the database; a miss falls
    // through to the AI exactly as before.
    const faqEntries = await getActiveFaqEntries();
    const faqMatch = matchFaq(message.text, faqEntries);
    if (faqMatch) {
      const suffix = intakeAskSuffix(profile);
      reply = suffix ? `${faqMatch.answer} ${suffix}` : faqMatch.answer;
    } else {
      reply = await generateReply(message.text, history, profile);
    }
  }

  await sendWhatsAppText(message.from, reply);


  if (askingForIntake && classification !== "HUMAN_REQUEST") {
    await incrementIntakeAttempts(message.from);
  }

  await saveMessage(message.from, "user", message.text);
  await saveMessage(message.from, "model", reply);

  // Brochure on request: the text reply above still answers whatever else they asked; the PDF
  // follows it. A failed send is logged, never allowed to break the rest of this turn.
  if (config.brochureUrl && isBrochureRequest(message.text)) {
    try {
      await sendWhatsAppDocument(message.from, config.brochureUrl, "GLO Preschool brochure.pdf", "GLO Preschool & Daycare, Tezpur");
      await saveMessage(message.from, "model", "[Brochure PDF sent]");
    } catch (err) {
      console.error("Brochure send failed:", err);
    }
  }

  // Pick up the child's name/age the moment either is shared - whether that's a direct answer to
  // being asked, or volunteered unprompted. Only bothers with the extra Gemini call while
  // there's still something missing to find.
  let latestChildName = profile.childName ?? undefined;
  let latestChildAge = profile.childAge ?? undefined;
  if (!profile.childName || !profile.childAge) {
    const precedingAssistantMessage =
      history.length > 0 && history[history.length - 1].role !== "user"
        ? history[history.length - 1].content
        : undefined;
    const extracted = await extractChildInfo(message.text, precedingAssistantMessage);
    if (extracted.childName || extracted.childAge) {
      await upsertFamilyProfile(message.from, {
        ...(extracted.childName ? { childName: extracted.childName } : {}),
        ...(extracted.childAge ? { childAge: extracted.childAge } : {}),
      });
    }
    latestChildName = extracted.childName ?? latestChildName;
    latestChildAge = extracted.childAge ?? latestChildAge;
  }

  await logEnquiry({
    // IST, not the server's own UTC clock - see formatIstDateTime for why.
    timestamp: formatIstDateTime(new Date(Number(message.timestamp) * 1000)),
    phone: message.from,
    question: message.text,
    aiAnswer: reply,
    classification,
  });

  // Plain-English running summary of the whole chat so far. Computed once here (using the full
  // history including the turn that was just saved) and reused for both the "Conversations" tab
  // and the CRM tab's Remarks column, so staff see the same up-to-date summary in either place.
  const fullHistory = [...history, { role: "user" as const, content: message.text }, { role: "model" as const, content: reply }];
  const summary = await summarizeConversation(fullHistory);

  // GLO's team works leads out of the shared "CRM" tab regardless of source (phone, visit, ads)
  // - see src/sheets.ts's upsertCrmLead for why this is safe to call on every message without
  // clobbering a staff member's own follow-up notes (Remarks aside - that's kept in sync with
  // the summary below on purpose).
  await upsertCrmLead({
    phone: message.from,
    parentName: message.parentName ?? profile.parentName ?? undefined,
    childName: latestChildName,
    childAge: latestChildAge,
    remarks: summary,
    source: message.source,
    // They wrote to us on WhatsApp, so the number is real: Hot, or Cold if the child's age is
    // outside what GLO takes. Only fills a blank or "Warm" label (see mergeQuality).
    quality: scoreLead({ phone: message.from, childAge: latestChildAge, repliedOnWhatsApp: true }).quality,
  });

  await upsertConversationSummary(message.from, summary, classification);
}

// The CRM's planned "Send WhatsApp" button hits this - it's what lets staff message a parent
// OUTSIDE the 24-hour reply window (a follow-up days later, a visit reminder), which
// sendWhatsAppText can't do. Kept separate from the webhook's reply path on purpose: this is
// staff-initiated, not triggered by an inbound message.
app.post("/send-template", express.json(), async (req, res) => {
  // Gated behind CRM_SEND_SECRET (see checkCrmSecret below) - this can push a message to a parent
  // at any time, not just reply to one they sent.
  if (!checkCrmSecret(req, res)) return;

  // bodyVariables is EITHER a plain array (positional {{1}}, {{2}} templates, e.g. ["Tirth"]) OR a
  // plain object keyed by name (named {{customer_name}} templates, e.g. {"customer_name":"Tirth"})
  // - whichever shape matches the template being sent. See the doc comment on sendWhatsAppTemplate
  // for why it's kept this simple rather than asking the caller to build Meta's own parameter
  // objects (a mismatch here is exactly what Meta rejected during testing on 18 Sept 2026).
  const { phone, templateName, languageCode, bodyVariables, pauseMinutes } = req.body as {
    phone?: string;
    templateName?: string;
    languageCode?: string;
    bodyVariables?: string[] | Record<string, string>;
    /** 0 = don't pause the bot (the CRM's automatic welcome to a new form lead, so the bot can
     * answer their reply). Default: pause like any staff message. */
    pauseMinutes?: number;
  };

  if (!phone || !templateName || !languageCode) {
    res.status(400).json({ error: "phone, templateName, and languageCode are required" });
    return;
  }

  try {
    await sendWhatsAppTemplate(phone, templateName, languageCode, bodyVariables ?? []);
    // Log this as a staff-side message too, same as /send-message does, so it shows up in the CRM's
    // chat viewer transcript (getFullConversation) instead of silently vanishing - previously this
    // endpoint never touched the conversation history at all.
    const pause = typeof pauseMinutes === "number" && pauseMinutes >= 0 ? pauseMinutes : DEFAULT_PAUSE_MINUTES;
    // An automatic welcome is the bot's own message, not a staff takeover: saved as "model" so it
    // doesn't clear a call-back flag or pause the bot.
    await saveMessage(phone, pause === 0 ? "model" : "staff", `WhatsApp template sent: ${templateName}`);
    if (pause > 0) await pauseBot(phone, pause);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error sending WhatsApp template:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// Morning enquiry digest email for the office (see src/officeDigest.ts): sends it now; ?dry=1 only
// returns the lists. The daily send is automatic (startDigestTimer).
app.post("/api/digest/run", async (req, res) => {
  if (!checkCrmSecret(req, res)) return;
  try {
    res.status(200).json(await sendOfficeDigest(req.query.dry === "1"));
  } catch (err) {
    console.error("Office digest failed:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// Every CRM endpoint can read a parent's chats or message them, so all of them REFUSE to work until
// CRM_SEND_SECRET is set (they used to fall open with a console warning, which let anyone who knew
// the Render URL and a parent's number read that family's chat). The CRM sends the same value as
// the x-api-key header, read from its Script Properties.
function checkCrmSecret(req: express.Request, res: express.Response): boolean {
  if (!config.crm.sendSecret) {
    res.status(503).json({ error: "CRM endpoints are locked: set CRM_SEND_SECRET on the server first." });
    return false;
  }
  if (req.header("x-api-key") !== config.crm.sendSecret) {
    res.status(401).json({ error: "Missing or invalid x-api-key" });
    return false;
  }
  return true;
}

// The CRM's chat-viewer popup hits this to load the full WhatsApp transcript for a lead, plus
// whether the bot is currently paused for them (see POST /send-message below).
// "Fix grammar" for teachers in GLO Progress. Called only by the Supabase bot-proxy function, which
// checks the caller is signed-in staff; same CRM_SEND_SECRET lock as the other app endpoints.
app.post("/api/topic-questions", express.json(), async (req, res) => {
  if (!checkCrmSecret(req, res)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const t = { cls: String(b.cls ?? "").slice(0, 60), subject: String(b.subject ?? "").slice(0, 60), title: String(b.title ?? "").slice(0, 200), note: String(b.note ?? "").slice(0, 600) };
  if (!t.title.trim()) {
    res.status(400).json({ error: "Pick a topic first." });
    return;
  }
  try {
    const questions = await topicQuestions(t);
    if (!questions.length) throw new Error("empty");
    res.status(200).json({ questions });
  } catch (err) {
    console.error("Topic questions failed:", err);
    res.status(502).json({ error: "Could not write questions right now. Please try again or write them yourself." });
  }
});

app.post("/api/grammar", express.json(), async (req, res) => {
  if (!checkCrmSecret(req, res)) return;
  const text = String((req.body as { text?: string })?.text ?? "");
  if (!text.trim() || text.length > 4000) {
    res.status(400).json({ error: "Write some text first (up to 4000 letters)." });
    return;
  }
  try {
    res.status(200).json({ text: await fixGrammar(text) });
  } catch (err) {
    console.error("Grammar fix failed:", err);
    res.status(502).json({ error: "Could not check the text right now. Please try again." });
  }
});

app.get("/conversation", async (req, res) => {
  if (!checkCrmSecret(req, res)) return;

  const phone = req.query.phone as string | undefined;
  if (!phone) {
    res.status(400).json({ error: "phone query parameter is required" });
    return;
  }

  try {
    const [messages, profile] = await Promise.all([getFullConversation(phone), getFamilyProfile(phone)]);
    res.status(200).json({
      ok: true,
      messages,
      pausedUntil: profile.pausedUntil,
      botPaused: isBotPaused(profile),
    });
  } catch (err) {
    console.error("Error loading conversation:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// The CRM's chat-viewer "Send" button hits this to let staff reply as themselves, inside the
// live 24-hour window (plain text via sendWhatsAppText, not a template) - and to pause the bot
// for that family afterwards so it doesn't talk over the human who just stepped in. Separate from
// /send-template, which is for template sends outside the 24-hour window instead.
const DEFAULT_PAUSE_MINUTES = 120;

app.post("/send-message", express.json(), async (req, res) => {
  if (!checkCrmSecret(req, res)) return;

  const { phone, message, pauseMinutes } = req.body as {
    phone?: string;
    message?: string;
    pauseMinutes?: number;
  };

  if (!phone || !message) {
    res.status(400).json({ error: "phone and message are required" });
    return;
  }

  try {
    await sendWhatsAppText(phone, message);
    await saveMessage(phone, "staff", message);
    await pauseBot(phone, pauseMinutes ?? DEFAULT_PAUSE_MINUTES);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error sending manual CRM message:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// ---------------------------------------------------------------------------------------------
// Staff inbox (/inbox): a small web page to read every WhatsApp conversation and reply as a human.
// Same lock as the CRM endpoints above: they refuse to work until CRM_SEND_SECRET is configured.
const requireInboxKey = checkCrmSecret;

app.get("/api/inbox/conversations", async (req, res) => {
  if (!requireInboxKey(req, res)) return;
  try {
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 500);
    res.status(200).json({ ok: true, conversations: await listConversations(limit) });
  } catch (err) {
    console.error("Error listing conversations:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

app.post("/api/inbox/conversations/:phone/read", async (req, res) => {
  if (!requireInboxKey(req, res)) return;
  try {
    await markConversationRead(req.params.phone);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error marking conversation read:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// Pause (minutes > 0) or resume (minutes = 0) the bot's auto-replies for one family.
app.post("/api/inbox/conversations/:phone/pause", async (req, res) => {
  if (!requireInboxKey(req, res)) return;
  const minutes = Number((req.body as { minutes?: number })?.minutes ?? DEFAULT_PAUSE_MINUTES);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 60 * 24 * 30) {
    res.status(400).json({ error: "minutes must be between 0 and 43200" });
    return;
  }
  try {
    await pauseBot(req.params.phone, minutes);
    res.status(200).json({ ok: true, paused: minutes > 0 });
  } catch (err) {
    console.error("Error pausing bot:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// The inbox page itself - static HTML/JS in /public. It asks for the inbox key once and sends it
// as x-api-key on every call, so the page is harmless without the key.
const publicDir = path.join(process.cwd(), "public");
app.get("/inbox", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(publicDir, "inbox.html"));
});

app.listen(config.port, () => {
  console.log(`GLO admissions bot listening on port ${config.port}`);
  startDigestTimer();
});
