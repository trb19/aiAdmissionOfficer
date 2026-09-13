import express from "express";
import { config } from "./config.js";
import { extractInboundMessages, sendWhatsAppText } from "./whatsapp.js";
import { classifyMessage, feeRedirectReply, humanHandoffReply, generateReply } from "./ai.js";
import { logEnquiry } from "./sheets.js";

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

    const classification = classifyMessage(message.text);

    let reply: string;
    if (classification === "FEE_QUESTION") {
      reply = feeRedirectReply(config.escalationPhone);
    } else if (classification === "HUMAN_REQUEST") {
      reply = humanHandoffReply(config.escalationPhone);
    } else {
      reply = await generateReply(message.text);
    }

    await sendWhatsAppText(message.from, reply);

    await logEnquiry({
      timestamp: new Date(Number(message.timestamp) * 1000).toISOString(),
      phone: message.from,
      question: message.text,
      aiAnswer: reply,
      classification,
    });
  }
}

app.listen(config.port, () => {
  console.log(`GLO admissions bot listening on port ${config.port}`);
});
