import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "./config.js";
import { factsWithEscalationNumber } from "./facts.js";

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

export async function generateReply(parentMessage: string): Promise<string> {
  const model = genAI.getGenerativeModel({ model: config.gemini.model });

  const prompt = `${SYSTEM_PROMPT_PREFIX}\n${factsWithEscalationNumber(
    config.escalationPhone
  )}\n\nParent's message: "${parentMessage}"\n\nYour reply:`;

  const result = await model.generateContent(prompt);
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
