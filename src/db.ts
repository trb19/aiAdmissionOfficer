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
