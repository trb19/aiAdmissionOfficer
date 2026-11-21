// Meta lead-form ads (Facebook / Instagram "Instant Forms"). When the Facebook Page is subscribed to
// the "leadgen" webhook field, Meta posts only the lead's ID to /webhook; the answers themselves are
// fetched from the Graph API with a Page access token that has the leads_retrieval permission.
// A forged webhook can't plant a lead: an ID that isn't a real lead on our Page fails the fetch.
import { config } from "./config.js";

export interface LeadgenEvent {
  leadgenId: string;
  pageId?: string;
  formId?: string;
  adId?: string;
}

/** Pulls leadgen events out of a Page webhook (object "page", field "leadgen"). WhatsApp webhooks
 * (object "whatsapp_business_account") yield nothing here. */
export function extractLeadgenEvents(body: unknown): LeadgenEvent[] {
  const b = body as any;
  if (b?.object !== "page") return [];
  const out: LeadgenEvent[] = [];
  for (const entry of b?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "leadgen" || !change?.value?.leadgen_id) continue;
      const v = change.value;
      out.push({ leadgenId: String(v.leadgen_id), pageId: v.page_id, formId: v.form_id, adId: v.ad_id });
    }
  }
  return out;
}

export interface MetaLead {
  name?: string;
  phone?: string;
  email?: string;
  city?: string;
  zip?: string;
  childName?: string;
  childAge?: string;
  /** Answers to any other questions on the form, "Question: answer". */
  extras: string[];
  platform: "Facebook" | "Instagram";
  campaignName?: string;
  adName?: string;
  isOrganic?: boolean;
}

interface FieldDatum {
  name?: string;
  values?: string[];
}

/** Maps a form's answers onto lead fields. Meta's standard questions use fixed keys (full_name,
 * phone_number, email, city, zip_code...); custom questions use a key made from the question text,
 * so those are matched loosely, the same way the CRM matches website form fields. */
export function parseMetaLeadFields(fieldData: FieldDatum[] | undefined): Omit<MetaLead, "platform"> {
  const lead: Omit<MetaLead, "platform"> = { extras: [] };
  let first = "";
  let last = "";
  for (const f of fieldData ?? []) {
    const key = String(f?.name ?? "").toLowerCase();
    const value = (f?.values ?? []).join(", ").trim();
    if (!key || !value) continue;
    if (key === "full_name" || key === "name") lead.name = value;
    else if (key === "first_name") first = value;
    else if (key === "last_name") last = value;
    else if (/phone|mobile|whatsapp|contact_number/.test(key)) lead.phone = lead.phone ?? value;
    else if (/e-?mail/.test(key)) lead.email = value;
    else if (/zip|post_?code|pin_?code|pincode/.test(key)) lead.zip = value;
    else if (/city|town|location|address|area|locality/.test(key)) lead.city = lead.city ? `${lead.city}, ${value}` : value;
    else if (/(^|_)age(_|$)|how_old|dob|birth|born/.test(key)) lead.childAge = value;
    else if (/child|kid|ward|son|daughter/.test(key)) lead.childName = value;
    else lead.extras.push(`${key.replace(/_/g, " ").replace(/\?$/, "")}: ${value}`);
  }
  if (!lead.name && (first || last)) lead.name = `${first} ${last}`.trim();
  return lead;
}

/** Fetches one lead's answers and the ad it came from. Throws on any Graph API error. */
export async function fetchMetaLead(leadgenId: string): Promise<MetaLead> {
  const token = config.meta.pageAccessToken;
  if (!token) throw new Error("META_PAGE_ACCESS_TOKEN is not set");
  const fields = "created_time,field_data,platform,campaign_name,ad_name,is_organic";
  const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${encodeURIComponent(leadgenId)}?fields=${fields}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Meta lead fetch failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as any;
  return {
    ...parseMetaLeadFields(data?.field_data),
    platform: String(data?.platform ?? "").toLowerCase() === "ig" ? "Instagram" : "Facebook",
    campaignName: data?.campaign_name || undefined,
    adName: data?.ad_name || undefined,
    isOrganic: Boolean(data?.is_organic),
  };
}
