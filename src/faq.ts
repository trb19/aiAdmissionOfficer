import type { FaqEntry } from "./db.js";

/**
 * Matches a parent's message against the pre-approved FAQ answers stored in Postgres (see
 * seedFaqEntries in src/db.ts), so the bot can answer common questions instantly and for free
 * instead of calling Gemini every time. Deliberately simple substring matching, not an AI call or
 * embeddings - a false negative here just falls through to the normal AI reply path in
 * server.ts, while a false positive would mean handing back a pre-written answer to the wrong
 * question. Keeping the matcher dumb and predictable (and keyword phrases specific, not single
 * common words) is the deliberate trade-off.
 *
 * First matching entry wins, in the order Postgres returns them - if this ever needs
 * prioritization (e.g. a more specific question should win over a broader one that also
 * matches), that's the place to add an explicit priority column rather than relying on row order.
 */
export function matchFaq(text: string, entries: FaqEntry[]): FaqEntry | null {
  const lower = text.toLowerCase();
  for (const entry of entries) {
    if (entry.keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) {
      return entry;
    }
  }
  return null;
}
