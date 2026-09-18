import express from "express";
import { config } from "./config.js";
import {
  extractInboundMessages,
  sendWhatsAppText,
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
} from "./ai.js";
import { matchFaq } from "./faq.js";
import { logEnquiry, upsertConversationSummary, upsertCrmLead, formatIstDateTime } from "./sheets.js";
import {
  getRecentHistory,
  saveMessage,
  getFamilyProfile,
  upsertFamilyProfile,
  incrementIntakeAttempts,
  getActiveFaqEntries,
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
  const messages = extractInboundMessages(body);

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

async function processMessage(message: InboundMessage): Promise<void> {
  // The WhatsApp display name arrives on every message but only needs to be stored once - safe
  // to call every time regardless, upsertFamilyProfile leaves other fields untouched.
  if (message.parentName) {
    await upsertFamilyProfile(message.from, { parentName: message.parentName });
  }

  const classification = classifyMessage(message.text);

  // Pulled once per message and reused for both the reply and the running summary below - this
  // is the bot's actual memory of the conversation so far (see src/db.ts), separate from the
  // Google Sheet's human-facing log.
  const history = await getRecentHistory(message.from);
  const profile = await getFamilyProfile(message.from);

  // Whether THIS reply is allowed to ask for the child's name/age, decided once up front from
  // the profile as it stood before this turn - both feeRedirectReply and generateReply make the
  // same decision independently, so this is what tells us afterwards whether to count it as an
  // attempt (see MAX_INTAKE_ATTEMPTS in ai.ts).
  const askingForIntake = needsIntake(profile);

  let reply: string;
  if (classification === "FEE_QUESTION") {
    reply = feeRedirectReply(profile);
  } else if (classification === "HUMAN_REQUEST") {
    reply = humanHandoffReply(config.escalationPhone);
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

  // Pick up the child's name/age the moment either is shared - whether that's a direct answer to
  // being asked, or volunteered unprompted. Only bothers with the extra Gemini call while
  // there's still something missing to find.
  let latestChildName = profile.childName ?? undefined;
  let latestChildAge = profile.childAge ?? undefined;
  if (!profile.childName || !profile.childAge) {
    const precedingAssistantMessage =
      history.length > 0 && history[history.length - 1].role === "model"
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
  });

  await upsertConversationSummary(message.from, summary, classification);
}

// The CRM's planned "Send WhatsApp" button hits this - it's what lets staff message a parent
// OUTSIDE the 24-hour reply window (a follow-up days later, a visit reminder), which
// sendWhatsAppText can't do. Kept separate from the webhook's reply path on purpose: this is
// staff-initiated, not triggered by an inbound message.
app.post("/send-template", express.json(), async (req, res) => {
  // Soft-gated behind CRM_SEND_SECRET (see config.ts) - not left open the way /webhook is, since
  // this one can push a message to a parent at any time, not just reply to one they sent.
  if (config.crm.sendSecret) {
    if (req.header("x-api-key") !== config.crm.sendSecret) {
      res.status(401).json({ error: "Missing or invalid x-api-key" });
      return;
    }
  } else {
    console.warn(
      "POST /send-template called with no CRM_SEND_SECRET configured - anyone with this URL can send templates. Set CRM_SEND_SECRET on Render once done testing."
    );
  }

  // bodyValues is plain strings in order, e.g. ["Tirth"] for a template whose body reads
  // "Hi {{1}}, ..." - see the doc comment on sendWhatsAppTemplate for why it's kept this simple
  // rather than asking the caller to build Meta's own parameter objects.
  const { phone, templateName, languageCode, bodyValues } = req.body as {
    phone?: string;
    templateName?: string;
    languageCode?: string;
    bodyValues?: string[];
  };

  if (!phone || !templateName || !languageCode) {
    res.status(400).json({ error: "phone, templateName, and languageCode are required" });
    return;
  }

  try {
    await sendWhatsAppTemplate(phone, templateName, languageCode, bodyValues ?? []);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error sending WhatsApp template:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

app.listen(config.port, () => {
  console.log(`GLO admissions bot listening on port ${config.port}`);
});
