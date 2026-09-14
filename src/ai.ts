import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "./config.js";
import { factsWithEscalationNumber } from "./facts.js";
import type { StoredMessage } from "./db.js";
import type { FamilyProfile } from "./db.js";

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

// A parent can ask for a fee multiple times in one conversation (or ignore the child-info ask and
// keep asking other things) - this caps how many times ANY reply, fee or routine, will work in a
// name/age ask before the bot gives up and stops mentioning it, so it never reads as nagging.
const MAX_INTAKE_ATTEMPTS = 2;

function needsIntake(profile: FamilyProfile): boolean {
  return (!profile.childName || !profile.childAge) && profile.intakeAttempts < MAX_INTAKE_ATTEMPTS;
}

/** Fee questions are handled entirely outside the AI - see the file-level comment in facts.ts for
 * why fee figures are kept out of the model's reach as a second line of defense. As of 14 Sept
 * 2026, GLO's policy changed from "direct them to call" to "our team follows up directly" - since
 * fees vary by class, this doubles as the natural moment to ask for the child's name and age if we
 * don't already have them, framed as "so we can tell you the right number" rather than a form. */
export function feeRedirectReply(profile: FamilyProfile): string {
  if (needsIntake(profile)) {
    return (
      `Fees depend on the class, so let me get you the right number - what's your child's name ` +
      `and age? Our team will follow up with the exact details.`
    );
  }
  const name = profile.childName;
  return name
    ? `Fees vary by class, so I'll have our team follow up with the exact details for ${name}.`
    : `Fees vary by class, so I'll have our team follow up with the exact details.`;
}

export function humanHandoffReply(escalationPhone: string): string {
  return (
    `Of course! You can reach our team directly at ${escalationPhone} and they'll be happy to help. ` +
    `Our office hours are 9:00am-5:00pm, Monday to Saturday.`
  );
}

/** Describes what the bot already knows about this family, in plain language, for the system
 * prompt - and tells the model plainly whether it's allowed to ask for the child's name/age this
 * turn. Keeping this logic here (not just "ask if missing") is what stops the bot from nagging a
 * parent who's already ignored the question twice. */
function profileContext(profile: FamilyProfile): string {
  const parentLine = profile.parentName
    ? `Parent's name (from their WhatsApp account - use it naturally, don't be certain it's exactly right): ${profile.parentName}`
    : `Parent's name: not known.`;

  const childLine =
    profile.childName && profile.childAge
      ? `Child's name and age: ${profile.childName}, ${profile.childAge}. You already know this - never ask again, and feel free to use the child's name occasionally.`
      : needsIntake(profile)
        ? `Child's name and age: not yet shared. Ask for both in one short, warm line, folded naturally into your reply - not a separate interrogation. Don't make it feel like a form.`
        : `Child's name and age: not yet shared, and you've already asked before. Do NOT ask again - just answer the question.`;

  return `${parentLine}\n${childLine}`;
}

function buildSystemPrompt(profile: FamilyProfile): string {
  return `
You are GLO Preschool & Daycare's WhatsApp admissions assistant, chatting with a parent enquiring
about admissions. Talk like a warm, switched-on staff member texting on WhatsApp - not a corporate
bot. This is a pilot with a limited scope - follow these rules exactly:

Style:
- Short sentences, one idea each. Default to 1-2 sentences per reply; use a 3rd only if genuinely needed.
- No corporate filler ("That's a great question!", "We're happy to help!", "Feel free to ask..."). Just answer.
- Never repeat a question, phrase, or sign-off you've already used earlier in this conversation - vary your wording.
- Ask at most one question per reply, and only if it's genuinely useful - never a generic "let me know if you have other questions."

What we know about this family:
${profileContext(profile)}

Answering:
1. Only answer using the approved facts below. If the answer isn't in them, say you're not certain
   and give the escalation phone number - never guess, estimate, or invent a detail (fees, ages,
   dates, capacity).
2. Never state a fee figure or amount under any circumstances, even if asked indirectly.
3. If you know the child's age, you can mention which program roughly fits, but never guess a
   specific class (Playgroup/Nursery/Jr KG/Sr KG) - only a staff member confirms exact placement.
4. You are speaking with an adult parent/guardian, not a child.

Approved facts:
`.trim();
}

/** Turns stored history rows into the shape Gemini's chat API expects. History is trimmed to
 * recent turns by src/db.ts before it ever reaches here - this function just reformats. */
function toGeminiHistory(history: StoredMessage[]) {
  return history.map((m) => ({ role: m.role, parts: [{ text: m.content }] }));
}

export async function generateReply(
  parentMessage: string,
  history: StoredMessage[] = [],
  profile: FamilyProfile
): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: config.gemini.model,
    systemInstruction: `${buildSystemPrompt(profile)}\n${factsWithEscalationNumber(config.escalationPhone)}`,
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

const EXTRACT_PROMPT_PREFIX = `
A parent is chatting with a preschool's WhatsApp admissions assistant. Look at the parent's latest
message (and the assistant's message just before it, for context) and decide if the parent has
shared their CHILD's name and/or age anywhere in it. Only extract information about the child, never
the parent's own name or age. If nothing new is shared, return null for that field - do not guess
or invent a value. Age can be in any form the parent used (e.g. "3", "3 years", "2.5 yrs", "18 months").

Respond with strict JSON only, matching this exact shape, nothing else:
{"childName": string or null, "childAge": string or null}
`.trim();

/** Runs after every parent message while the child's name/age are still unknown, so the bot picks
 * up the info the moment it's shared - whether that's a direct answer to being asked, or
 * volunteered unprompted in a message about something else entirely. A separate, cheap JSON-mode
 * call rather than trying to parse it out of the conversational reply, which is free-text and not
 * reliably parseable. */
export async function extractChildInfo(
  parentMessage: string,
  precedingAssistantMessage?: string
): Promise<{ childName: string | null; childAge: string | null }> {
  const model = genAI.getGenerativeModel({
    model: config.gemini.model,
    generationConfig: { responseMimeType: "application/json" },
  });

  const context = precedingAssistantMessage
    ? `Assistant's previous message: ${precedingAssistantMessage}\nParent's latest message: ${parentMessage}`
    : `Parent's latest message: ${parentMessage}`;

  try {
    const result = await model.generateContent(`${EXTRACT_PROMPT_PREFIX}\n\n${context}`);
    const parsed = JSON.parse(result.response.text().trim());
    return {
      childName: typeof parsed.childName === "string" && parsed.childName.trim() ? parsed.childName.trim() : null,
      childAge: typeof parsed.childAge === "string" && parsed.childAge.trim() ? parsed.childAge.trim() : null,
    };
  } catch (err) {
    // Never let a parsing hiccup break the reply path - worst case, the bot just asks again next
    // turn (bounded by MAX_INTAKE_ATTEMPTS) instead of silently losing what was shared.
    console.error("Failed to extract child info:", err);
    return { childName: null, childAge: null };
  }
}

export { needsIntake, MAX_INTAKE_ATTEMPTS };

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
