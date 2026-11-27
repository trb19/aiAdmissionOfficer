/**
 * Also save every lead into GLO Progress (Supabase),
 * so the Enquiries section in the app gets WhatsApp, website, Google and Meta leads the moment they
 * arrive. Called from upsertCrmLead in src/sheets.ts, next to the sheet write, so during the move
 * both stay in step. Once the office works only in the app, the sheet write can be switched off.
 *
 * Env (Render): PROGRESS_SUPABASE_URL, PROGRESS_SERVICE_KEY (a Supabase secret key, sb_secret_..., or the legacy service_role key; keep it
 * only on the server). If either is missing this does nothing, so it is safe to deploy first.
 */
import type { CrmLeadUpdate } from "./sheets.js";

export async function saveLeadToProgress(u: CrmLeadUpdate): Promise<void> {
  const url = process.env.PROGRESS_SUPABASE_URL;
  const key = process.env.PROGRESS_SERVICE_KEY;
  if (!url || !key) return;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/bot_upsert_lead`, {
      method: "POST",
      // new-style secret keys (sb_secret_...) go only in apikey; old JWT service_role keys also go in Authorization
      headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" },
      body: JSON.stringify({
        p_phone: u.phone,
        p_parent: u.parentName ?? null,
        p_child: u.childName ?? null,
        p_age: u.childAge ?? null,
        p_source: u.source ?? "Whatsapp",
        p_remark: u.remarks ?? null,
        p_note: u.note ?? null,
        p_address: u.address ?? null,
        p_quality: u.quality ?? null,
      }),
    });
    if (!res.ok) console.error("GLO Progress lead save failed:", res.status, await res.text());
  } catch (err) {
    // Same rule as the sheet: never let this break a parent's reply.
    console.error("GLO Progress lead save failed:", err);
  }
}
