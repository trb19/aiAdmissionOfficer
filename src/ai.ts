import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "./config.js";
import { factsWithEscalationNumber } from "./facts.js";
import type { StoredMessage } from "./db.js";

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

export type MessageClass = "FEE_QUESTION" | "HUMAN_REQUEST" | "ROUTINE";

// Deliberately simple, deliberately not the AI's own judgment. GLO's fee-disclosure policy and
// the "let a parent reach a person" case are both important enough that they should not depend on
// the model reliably following an instruction every single time - a keyword match short-circuits
// the AI call entirely for these two cases, so there's nothing for the model to get wrong.
const FEE_KEYWORDS = /\b(fee|fees|cost|costs|price|pricing|charge|charges|tuition|payment|pay|how much)\b/i;
const HUMAN_KEYWORDS = /\b(human|person|staff|talk to (someone|somebody)|speak to (someone|somebody)|call me|representative)\b/i;

export function classifyMessage(text: string): MessageClass {
  if (FEE_KEYWORDS.test(text)) return "FEE_QUESTION";
  if (HUMAN_KEYWORDS.test(text)) return "HUMAN_REQUEST";
  return "ROUTINE";
}

export function feeRedirectReply(escalationPhone: string): string {
  return (
    `That's a great question - our fee details are best explained over a quick call so we can ` +
    `walk you through everything clearly. Please call us at ${escalationPhone} and our team will ` +
    `help you out!`
  );
}

export function humanHandoffReply(escalationPhone: string): string {
  return (
    `Of course! You can reach our team directly at ${escalationPhone} and they'll be happy to help. ` +
    `Our office hours are 9:00am-5:00pm, Monday to Saturday.`
  );
}

const SYSTEM_PROMPT_PREFIX = `
You are GLO Preschool & Daycare's WhatsApp admissions assistant, replying to a parent enquiring
about admissions. This is a pilot with a limited scope - follow these rules exactly:

1. Only answer using the approved facts below. If the answer isn't in the approved facts, say you
   are not certain and give the escalation phone number - never guess, estimate, or make up a
   detail (including anything about fees, exact ages, dates, or capacity).
2. Never state a fee figure or amount under any circumstances, even if asked indirectly.
3. Keep replies short - one to three sentences, warm and simple, no long lists.
4. Ask at most one follow-up question, only if it's genuinely useful.
5. You are speaking with an adult parent/guardian, not a child.

Approved facts:
`.trim();

/** Turns stored history rows into the shape Gemini's chat API expects. History is trimmed to
 * recent turns by src/db.ts before it ever reaches here - this function just reformats. */
function toGeminiHistory(history: StoredMessage[]) {
  return history.map((m) => ({ role: m.role, parts: [{ text: m.content }] }));
}

export async function generateReply(
  parentMessage: string,
  history: StoredMessage[] = []
): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: config.gemini.model,
    systemInstruction: `${SYSTEM_PROMPT_PREFIX}\n${factsWithEscalationNumber(config.escalationPhone)}`,
  });

  // A real multi-turn chat (via startChat) rather than a single one-shot prompt is what lets the
  // bot understand a follow-up like "what about the Daycare program instead?" - Gemini sees the
  // preceding turns as actual conversation history, not just static context stuffed into one
  // string. History is capped upstream (src/db.ts) so this stays a short, cheap call.
  const chat = model.startChat({ history: toGeminiHistory(history) });
  const result = await chat.sendMessage(parentMessage);
  const text = result.response.text().trim();

  // A model refusal, empty response, or something absurdly long is treated as a failure rather
  // than sent to a parent as-is - fall back to a safe, honest message and let a human take it
  // from there. This mirrors the master spec's "no claim of certainty from an uncertain model"
  // stance, scaled down to what a keyword check plus a length guard can catch in Phase 0.
  if (!text || text.length > 800) {
    return `Thanks for reaching out! Let me have our team get back to you on that - you can also call ${config.escalationPhone} directly.`;
  }

  return text;
}

const SUMMARY_PROMPT_PREFIX = `
Summarize the WhatsApp conversation below between a parent and GLO Preschool & Daycare's
admissions assistant, for a staff member skimming a spreadsheet - not for the parent. Write 1-3
short sentences covering: what the parent is asking about or interested in, anything notable GLO
should follow up on (e.g. they were told to call about fees, they asked for a human), and the
overall state of the conversation. Do not invent details that aren't in the conversation. Do not
include a greeting or preamble - output only the summary itself.

Conversation:
`.trim();

/** Produces the short running summary stored in the Google Sheet's "Conversations" tab (see
 * src/sheets.ts's upsertConversationSummary). This is a separate, cheap Gemini call made after
 * every reply - fine at Phase 0's volume, and worth revisiting (e.g. only re-summarize every few
 * messages) if usage grows enough for the extra call to matter. */
export async function summarizeConversation(history: StoredMessage[]): Promise<string> {
  const model = genAI.getGenerativeModel({ model: config.gemini.model });

  const transcript = history
    .map((m) => `${m.role === "user" ? "Parent" : "Assistant"}: ${m.content}`)
    .join("\n");

  const result = await model.generateContent(`${SUMMARY_PROMPT_PREFIX}\n${transcript}`);
  const text = result.response.text().trim();

  return text || "No summary available.";
}
