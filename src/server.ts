import express from "express";
import { config } from "./config.js";
import { extractInboundMessages, sendWhatsAppText } from "./whatsapp.js";
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
import { logEnquiry, upsertConversationSummary } from "./sheets.js";
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
    }

    await logEnquiry({
      timestamp: new Date(Number(message.timestamp) * 1000).toISOString(),
      phone: message.from,
      question: message.text,
      aiAnswer: reply,
      classification,
    });

    // Refresh the plain-English running summary staff see in the "Conversations" tab. Uses the
    // full history including the turn that was just saved, so the summary always reflects what
    // the parent just said and how the bot just answered.
    const fullHistory = [...history, { role: "user" as const, content: message.text }, { role: "model" as const, content: reply }];
    const summary = await summarizeConversation(fullHistory);
    await upsertConversationSummary(message.from, summary, classification);
  }
}

app.listen(config.port, () => {
  console.log(`GLO admissions bot listening on port ${config.port}`);
});
