/**
 * Durable conversation memory, backed by Postgres (Render's free-tier Postgres works fine for
 * Phase 0's volume). This is deliberately separate from the Google Sheet: the sheet is the
 * human-facing log staff read, this is the bot's own short-term working memory so it can hold a
 * coherent back-and-forth with a parent instead of treating every message as a fresh start.
 *
 * Survives restarts and Render's free-instance spin-downs on purpose - that's the whole point of
 * using a real database instead of an in-memory Map like the message-dedup set in server.ts.
 */
import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.database.url,
      // Render's managed Postgres requires SSL; rejectUnauthorized:false matches Render's own
      // connection examples since it uses a Render-issued cert chain most Node setups don't trust
      // by default.
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

let schemaReadyPromise: Promise<void> | null = null;

/** Creates the tables if they don't exist yet. Safe to call on every boot - CREATE TABLE IF NOT
 * EXISTS is idempotent. Called lazily on first use rather than at import time, so a missing/bad
 * DATABASE_URL fails when the DB is actually needed, not at process startup. */
function ensureSchema(): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = getPool().query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'model')),
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS messages_phone_created_at_idx ON messages (phone, created_at);

      CREATE TABLE IF NOT EXISTS conversation_summaries (
        phone TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS family_profiles (
        phone TEXT PRIMARY KEY,
        parent_name TEXT,
        child_name TEXT,
        child_age TEXT,
        intake_attempts INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS faq_entries (
        id TEXT PRIMARY KEY,
        keywords TEXT[] NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- 'staff' role added 19 Sept 2026 for the CRM's "reply as human" chat viewer feature -
      -- a message a staff member sends manually from the CRM, distinct from the bot's own
      -- 'model' replies, so the transcript can show who actually said what.
      ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_role_check;
      ALTER TABLE messages ADD CONSTRAINT messages_role_check CHECK (role IN ('user', 'model', 'staff'));

      -- paused_until: set when a staff member sends a manual reply from the CRM chat viewer, so
      -- the bot skips auto-replying to that parent for a while and doesn't talk over a human who
      -- just stepped in. NULL (the default) means "not paused".
      ALTER TABLE family_profiles ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ;
    `).then(() => seedFaqEntries());
  }
  return schemaReadyPromise;
}

/** Pre-approved answers to GLO's most common parent questions, matched by keyword phrase instead
 * of going through Gemini - see src/faq.ts for the matching logic. Seeded once via ON CONFLICT DO
 * NOTHING, so this is only ever the *starting* set: editing a row afterwards (e.g. "UPDATE
 * faq_entries SET answer = ... WHERE id = 'age-eligibility'") is how these get corrected or
 * expanded going forward, without needing a code change or redeploy. Keep every answer here
 * grounded in GLO_APPROVED_FACTS (src/facts.ts) - this table bypasses the AI, not the facts
 * policy, so it still must never state a fee figure. */
const FAQ_SEED: Array<{ id: string; keywords: string[]; question: string; answer: string }> = [
  {
    id: "age-eligibility",
    keywords: [
      "what age",
      "which age",
      "minimum age",
      "age limit",
      "age criteria",
      "age eligib",
      "too young",
      "old enough",
    ],
    question: "What age can my child join?",
    answer:
      "Playgroup is from 18 months, Nursery from 3 years, Jr. KG from 4 years, and Sr. KG from 5 years - measured as of 1st April of the academic year. These are ideal bands, so a staff member will confirm the exact class based on your child's date of birth.",
  },
  {
    id: "classes-offered",
    keywords: ["which classes", "what classes", "how many classes", "classes do you have", "grades do you have"],
    question: "What classes do you have?",
    answer:
      "We have four classes: Playgroup, Nursery, Jr. KG, and Sr. KG, plus a separate Daycare program.",
  },
  {
    id: "curriculum",
    keywords: ["curriculum", "medium of instruction", "what do you teach", "what will my child learn"],
    question: "What's the curriculum / medium of instruction?",
    answer:
      "We follow a play-based early-years curriculum focused on skills for the future. English is the primary medium of instruction, though Assamese/Hindi/English are all used as needed with parents. From Playgroup, children start learning phonics, developing motor skills, and picking up practical life skills. By the time they finish Sr. KG, they read and write independently, speak confidently, and have developed questioning skills - a foundation that helps them throughout their education journey.",
  },
  {
    id: "location",
    keywords: ["where are you located", "your address", "school address", "where is the school", "location", "google maps", "map location"],
    question: "Where are you located?",
    answer:
      "We're at Bylane 3, Baroholia, Tezpur, Assam. Here's our Google Maps location: https://maps.app.goo.gl/rsHjmAdNVXp3MCqBA",
  },
  {
    id: "visit-tour",
    keywords: ["can we visit", "school tour", "want to visit", "see the campus", "come and see", "which days can we visit", "open sunday", "visit on saturday"],
    question: "Can we visit the school?",
    answer:
      "Of course! Visits are welcome any day except Sunday, generally 1:00pm-3:00pm. When are you planning to visit? We'll schedule it and mark our calendar.",
  },
  {
    id: "office-hours",
    keywords: ["office hours", "when are you open", "what are your hours", "office timing", "school timing", "school hours", "daycare timing", "daycare hours"],
    question: "What are your hours?",
    answer:
      "School timings (Playgroup/Nursery/Jr. KG/Sr. KG) are 9:30am-12:30pm. Daycare is 8:30am-5:30pm. Our office hours are 9:00am-4:00pm.",
  },
  {
    id: "student-teacher-ratio",
    keywords: ["teacher ratio", "student ratio", "staff ratio", "student-teacher", "students per teacher", "children per teacher"],
    question: "What's your student-teacher ratio?",
    answer: "Our student-teacher ratio is 5:1.",
  },
  {
    id: "settling-in",
    keywords: [
      "guardian allowed",
      "parent allowed",
      "stay with child",
      "stay inside",
      "settle in",
      "settling in",
      "first day",
      "will he cry",
      "will she cry",
    ],
    question: "Can I stay with my child on the first day?",
    answer:
      "Parents wait in our waiting area rather than inside with the child - it helps them settle in and bond with staff faster. We'll call you if your child needs you. Each child gets a dedicated caretaker, and most settle in within 1-2 weeks.",
  },
  {
    id: "flexible-timing",
    keywords: [
      "start with less time",
      "shorter hours",
      "half day",
      "reduce timing",
      "1 hour",
      "one hour",
      "gradually increase",
      "adjusted for",
    ],
    question: "Can my child start with shorter hours?",
    answer:
      "Yes, timing is flexible for new admissions - your child can start with just an hour a day and we increase it gradually as they settle in.",
  },
  {
    id: "playgroup-style",
    keywords: [
      "sit and study",
      "sit in chairs",
      "seated study",
      "structured study",
      "will he study",
      "will she study",
      "play related games",
      "play based",
    ],
    question: "Is it play-based or structured study?",
    answer:
      "It's entirely play-based, especially in Playgroup - no chairs, no forced seated study. Kids learn through play and activities.",
  },
];

async function seedFaqEntries(): Promise<void> {
  for (const entry of FAQ_SEED) {
    await getPool().query(
      `INSERT INTO faq_entries (id, keywords, question, answer) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [entry.id, entry.keywords, entry.question, entry.answer]
    );
  }
  await syncCorrectedFaqAnswers();
}

/** One-time (per boot) targeted fix-up for FAQ rows whose already-seeded answer needs to catch up
 * with a code-level correction, since seedFaqEntries()'s ON CONFLICT DO NOTHING never touches a row
 * that already exists. Each entry here is a specific "row X's live answer is stale, force it to the
 * current FAQ_SEED text" fix - not a general always-sync (that would fight direct DB edits, which is
 * the intended way to correct/expand answers per this file's own doc comment above). The WHERE clause
 * makes this a no-op once the row matches, so it's safe to leave in permanently instead of removing
 * it after one deploy.
 * - "curriculum": corrected 14 Sept 2026 to the play-based/phonics/skills-for-the-future wording
 *   Tirth confirmed; the row had been seeded with the old placeholder text before that. */
async function syncCorrectedFaqAnswers(): Promise<void> {
  const idsToSync = ["curriculum"];
  for (const id of idsToSync) {
    const entry = FAQ_SEED.find((e) => e.id === id);
    if (!entry) continue;
    await getPool().query(
      `UPDATE faq_entries SET keywords = $2, question = $3, answer = $4, updated_at = now()
       WHERE id = $1 AND answer IS DISTINCT FROM $4`,
      [entry.id, entry.keywords, entry.question, entry.answer]
    );
  }
}

export interface FaqEntry {
  id: string;
  keywords: string[];
  question: string;
  answer: string;
}

/** Pulled fresh on every message rather than cached in memory, so an edit made directly in the
 * database (e.g. by Tirth asking Claude to update an answer) takes effect immediately without a
 * restart - at Phase 0's traffic this extra query is negligible. */
export async function getActiveFaqEntries(): Promise<FaqEntry[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{ id: string; keywords: string[]; question: string; answer: string }>(
    `SELECT id, keywords, question, answer FROM faq_entries WHERE active = true`
  );
  return rows;
}

export interface StoredMessage {
  role: "user" | "model" | "staff";
  content: string;
}

/** How many past turns (user+model pairs) to pull back as context for a new reply. Kept small on
 * purpose: WhatsApp admissions chats are short, and a shorter prompt is cheaper and less likely to
 * distract Gemini from the approved-facts instructions with old, possibly stale context. */
const HISTORY_TURNS = 6;

export async function getRecentHistory(phone: string): Promise<StoredMessage[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{ role: "user" | "model" | "staff"; content: string }>(
    `SELECT role, content FROM messages WHERE phone = $1 ORDER BY created_at DESC LIMIT $2`,
    [phone, HISTORY_TURNS * 2]
  );
  return rows.reverse();
}

/** Full message history for a phone, oldest first, with timestamps - for the CRM's chat viewer
 * (unlike getRecentHistory, which is capped at HISTORY_TURNS for the AI prompt, this returns
 * everything so staff can scroll the whole conversation). */
export interface ConversationMessage {
  role: "user" | "model" | "staff";
  content: string;
  createdAt: string;
}

export async function getFullConversation(phone: string): Promise<ConversationMessage[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    role: "user" | "model" | "staff";
    content: string;
    created_at: Date;
  }>(`SELECT role, content, created_at FROM messages WHERE phone = $1 ORDER BY created_at ASC`, [phone]);
  return rows.map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at.toISOString() }));
}

export async function saveMessage(
  phone: string,
  role: "user" | "model" | "staff",
  content: string
): Promise<void> {
  await ensureSchema();
  await getPool().query(`INSERT INTO messages (phone, role, content) VALUES ($1, $2, $3)`, [
    phone,
    role,
    content,
  ]);
}

export async function getStoredSummary(phone: string): Promise<string | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{ summary: string }>(
    `SELECT summary FROM conversation_summaries WHERE phone = $1`,
    [phone]
  );
  return rows[0]?.summary ?? null;
}

export async function saveSummary(phone: string, summary: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO conversation_summaries (phone, summary, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (phone) DO UPDATE SET summary = EXCLUDED.summary, updated_at = now()`,
    [phone, summary]
  );
}

/** What the bot has learned about this family so far - the parent's WhatsApp display name
 * (captured automatically, never asked for), the child's name and age (asked for naturally in
 * conversation, extracted from whatever the parent replies), and how many times the bot has
 * already asked for the child's name/age. Everything is nullable: a brand-new phone number simply
 * has no row yet. */
export interface FamilyProfile {
  parentName: string | null;
  childName: string | null;
  childAge: string | null;
  intakeAttempts: number;
  // ISO timestamp, or null if the bot isn't paused for this family. See pauseBot below.
  pausedUntil: string | null;
}

const EMPTY_PROFILE: FamilyProfile = {
  parentName: null,
  childName: null,
  childAge: null,
  intakeAttempts: 0,
  pausedUntil: null,
};

export async function getFamilyProfile(phone: string): Promise<FamilyProfile> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    parent_name: string | null;
    child_name: string | null;
    child_age: string | null;
    intake_attempts: number;
    paused_until: Date | null;
  }>(
    `SELECT parent_name, child_name, child_age, intake_attempts, paused_until FROM family_profiles WHERE phone = $1`,
    [phone]
  );
  const row = rows[0];
  if (!row) return EMPTY_PROFILE;
  return {
    parentName: row.parent_name,
    childName: row.child_name,
    childAge: row.child_age,
    intakeAttempts: row.intake_attempts,
    pausedUntil: row.paused_until ? row.paused_until.toISOString() : null,
  };
}

/** True while the bot should stay quiet for this family - set by pauseBot whenever a staff member
 * sends a manual reply from the CRM's chat viewer, so the bot doesn't talk over a human who just
 * stepped in. */
export function isBotPaused(profile: FamilyProfile): boolean {
  return !!profile.pausedUntil && new Date(profile.pausedUntil).getTime() > Date.now();
}

/** Pauses the bot's auto-replies to this phone for the given number of minutes from now -
 * overwriting any earlier pause, so sending a second manual reply extends the quiet period rather
 * than stacking with the first. Pass minutes <= 0 to clear a pause immediately (unpause). */
export async function pauseBot(phone: string, minutes: number): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO family_profiles (phone, paused_until, updated_at)
     VALUES ($1, CASE WHEN $2::float <= 0 THEN NULL ELSE now() + ($2::float * interval '1 minute') END, now())
     ON CONFLICT (phone) DO UPDATE SET
       paused_until = CASE WHEN $2::float <= 0 THEN NULL ELSE now() + ($2::float * interval '1 minute') END,
       updated_at = now()`,
    [phone, minutes]
  );
}

/** Upserts whichever fields are provided, leaving existing values in place for fields left
 * undefined - so capturing the WhatsApp display name on message 1 doesn't clobber a child's name
 * learned on message 3, and vice versa. */
export async function upsertFamilyProfile(
  phone: string,
  fields: { parentName?: string; childName?: string; childAge?: string }
): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO family_profiles (phone, parent_name, child_name, child_age, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (phone) DO UPDATE SET
       parent_name = COALESCE(EXCLUDED.parent_name, family_profiles.parent_name),
       child_name = COALESCE(EXCLUDED.child_name, family_profiles.child_name),
       child_age = COALESCE(EXCLUDED.child_age, family_profiles.child_age),
       updated_at = now()`,
    [phone, fields.parentName ?? null, fields.childName ?? null, fields.childAge ?? null]
  );
}

/** Bumps the "how many times have we asked for the child's name/age" counter. Called whenever a
 * reply goes out that includes that ask, so the bot can stop after a couple of tries instead of
 * nagging a parent who's ignoring the question. */
export async function incrementIntakeAttempts(phone: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO family_profiles (phone, intake_attempts, updated_at)
     VALUES ($1, 1, now())
     ON CONFLICT (phone) DO UPDATE SET
       intake_attempts = family_profiles.intake_attempts + 1,
       updated_at = now()`,
    [phone]
  );
}
