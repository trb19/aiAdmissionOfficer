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
    `).then(() => undefined);
  }
  return schemaReadyPromise;
}

export interface StoredMessage {
  role: "user" | "model";
  content: string;
}

/** How many past turns (user+model pairs) to pull back as context for a new reply. Kept small on
 * purpose: WhatsApp admissions chats are short, and a shorter prompt is cheaper and less likely to
 * distract Gemini from the approved-facts instructions with old, possibly stale context. */
const HISTORY_TURNS = 6;

export async function getRecentHistory(phone: string): Promise<StoredMessage[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{ role: "user" | "model"; content: string }>(
    `SELECT role, content FROM messages WHERE phone = $1 ORDER BY created_at DESC LIMIT $2`,
    [phone, HISTORY_TURNS * 2]
  );
  return rows.reverse();
}

export async function saveMessage(phone: string, role: "user" | "model", content: string): Promise<void> {
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
}

const EMPTY_PROFILE: FamilyProfile = {
  parentName: null,
  childName: null,
  childAge: null,
  intakeAttempts: 0,
};

export async function getFamilyProfile(phone: string): Promise<FamilyProfile> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    parent_name: string | null;
    child_name: string | null;
    child_age: string | null;
    intake_attempts: number;
  }>(
    `SELECT parent_name, child_name, child_age, intake_attempts FROM family_profiles WHERE phone = $1`,
    [phone]
  );
  const row = rows[0];
  if (!row) return EMPTY_PROFILE;
  return {
    parentName: row.parent_name,
    childName: row.child_name,
    childAge: row.child_age,
    intakeAttempts: row.intake_attempts,
  };
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
