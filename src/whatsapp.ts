import { config } from "./config.js";

const GRAPH_BASE = "https://graph.facebook.com";

/** Shape of the bits of Meta's webhook payload this bot actually reads. Meta sends a lot more
 * than this; everything else is ignored on purpose to keep this bot's surface area small. */
export interface InboundMessage {
  messageId: string;
  from: string; // E.164-ish, no leading +, as Meta sends it
  text: string;
  timestamp: string;
  // The display name on the sender's WhatsApp account, e.g. "Priya Sharma" - Meta includes this in
  // every webhook payload's "contacts" array, so the bot can address a parent by name without ever
  // having to ask for it. Not guaranteed accurate (it's whatever name they've set on WhatsApp, not
  // a verified identity - could be a nickname, a child's name, or a shared family phone), so this
  // is used as a warm touch, never as a fact recorded anywhere that matters.
  parentName?: string;
  /** Where this parent found GLO, when the message itself says so (see detectLeadSource). Only
   * used for the CRM's Source column on a brand-new lead; undefined means plain WhatsApp. */
  source?: string;
}

/** Text the website's WhatsApp buttons pre-fill, so a chat started from gloschools.com can be told
 * apart from someone who saved the number. Kept loose on purpose: parents often edit the text. */
const WEBSITE_MARKERS = [/\(website\)/i, /^hi glo!? i would like to book a school visit/i];

/** Lead source for the CRM: Meta attaches a `referral` object to the first message of a chat that
 * started from a Facebook/Instagram click-to-WhatsApp ad; website buttons pre-fill known text. */
export function detectLeadSource(msg: any): string | undefined {
  const referral = msg?.referral;
  if (referral) {
    const where = `${referral.source_url ?? ""} ${referral.source_type ?? ""}`.toLowerCase();
    // Same names staff already use in the CRM's Source list, so the dashboard groups them together.
    return where.includes("instagram") ? "Insta Ads" : "Facebook Ads";
  }
  const text: string = msg?.text?.body ?? "";
  if (WEBSITE_MARKERS.some((re) => re.test(text.trim()))) return "Website";
  return undefined;
}

/** Meta's webhook fires for every kind of event (message status updates, template events, etc),
 * not just new inbound text messages. This pulls out just the plain text messages we handle in
 * Phase 0 and ignores everything else (images, locations, button replies, status callbacks). */
export function extractInboundMessages(body: unknown): InboundMessage[] {
  const messages: InboundMessage[] = [];

  const entries = (body as any)?.entry ?? [];
  for (const entry of entries) {
    const changes = entry?.changes ?? [];
    for (const change of changes) {
      const value = change?.value;
      const rawMessages = value?.messages ?? [];
      const contacts = value?.contacts ?? [];

      for (const msg of rawMessages) {
        if (msg?.type === "text" && msg?.text?.body) {
          const contact = contacts.find((c: any) => c?.wa_id === msg.from);
          messages.push({
            messageId: msg.id,
            from: msg.from,
            text: msg.text.body,
            timestamp: msg.timestamp,
            parentName: contact?.profile?.name || undefined,
            source: detectLeadSource(msg),
          });
        }
        // Non-text message types (image, audio, location, interactive button replies, etc.) are
        // deliberately not handled in Phase 0 - the spec calls for a safe acknowledgement and
        // human routing for attachments, which is a Phase 1 addition, not a Phase 0 one.
      }
    }
  }

  return messages;
}

/** A non-text message (photo, voice note, document, location, button tap...) - the bot doesn't
 * answer these, but they're saved into the conversation so staff see them in /inbox instead of
 * the message silently vanishing. `label` is a short human-readable stand-in for the transcript,
 * e.g. "[Voice note]" or "[Photo] caption text". */
export interface InboundAttachment {
  messageId: string;
  from: string;
  timestamp: string;
  parentName?: string;
  type: string;
  label: string;
}

const ATTACHMENT_LABELS: Record<string, string> = {
  image: "Photo",
  audio: "Voice note",
  voice: "Voice note",
  video: "Video",
  document: "Document",
  sticker: "Sticker",
  location: "Location",
  contacts: "Contact card",
  reaction: "Reaction",
};

export function extractInboundAttachments(body: unknown): InboundAttachment[] {
  const out: InboundAttachment[] = [];
  for (const entry of (body as any)?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const contacts = value?.contacts ?? [];
      for (const msg of value?.messages ?? []) {
        if (!msg?.type || msg.type === "text") continue;
        const contact = contacts.find((c: any) => c?.wa_id === msg.from);
        let label: string;
        if (msg.type === "button") {
          label = `[Button] ${msg.button?.text ?? ""}`.trim();
        } else if (msg.type === "interactive") {
          const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
          label = `[Button] ${reply?.title ?? ""}`.trim();
        } else if (msg.type === "location") {
          const loc = msg.location ?? {};
          label = `[Location] ${loc.name ?? ""} ${loc.latitude ?? ""},${loc.longitude ?? ""}`.replace(/\s+/g, " ").trim();
        } else if (msg.type === "reaction") {
          label = `[Reaction] ${msg.reaction?.emoji ?? ""}`.trim();
        } else {
          const media = msg[msg.type] ?? {};
          const caption = media.caption ?? media.filename ?? "";
          label = `[${ATTACHMENT_LABELS[msg.type] ?? msg.type}]${caption ? " " + caption : ""}`;
        }
        out.push({
          messageId: msg.id,
          from: msg.from,
          timestamp: msg.timestamp,
          parentName: contact?.profile?.name || undefined,
          type: msg.type,
          label,
        });
      }
    }
  }
  return out;
}

/** Parent is asking for the brochure / prospectus / a PDF with the details. */
export function isBrochureRequest(text: string): boolean {
  return /\b(brochure|prospectus|pamphlet|leaflet|catalogue|catalog)\b|\bpdf\b/i.test(text);
}

/** Sends a PDF by public link (Meta fetches it). Same 24-hour-window rule as text messages. */
export async function sendWhatsAppDocument(to: string, link: string, filename: string, caption?: string): Promise<void> {
  const url = `${GRAPH_BASE}/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { link, filename, ...(caption ? { caption } : {}) },
    }),
  });
  if (!res.ok) throw new Error(`WhatsApp document send failed: ${res.status} ${await res.text()}`);
}

export async function sendWhatsAppText(to: string, body: string): Promise<void> {
  const url = `${GRAPH_BASE}/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`WhatsApp send failed (${res.status}): ${errorBody}`);
  }
}

/** Sends an approved WhatsApp message template - the only way to message a parent OUTSIDE a live
 * 24-hour conversation window (a follow-up days later, a visit reminder, etc). Unlike
 * sendWhatsAppText, this can't send arbitrary text: `name` must exactly match an Active template
 * in Meta's WhatsApp Manager (the numeric template ID shown there, e.g. 2850457925307994, is NOT
 * what goes here - Meta's send API addresses templates by name + language, not by that ID).
 *
 * `bodyVariables` fills in the template's placeholders and comes in TWO shapes, because Meta's
 * templates do (root-caused 18 Sept 2026 testing against the real "send_hi" template, which uses
 * the newer named style and rejected the positional shape with "Parameter name is missing or
 * empty"):
 *  - a template written with {{1}}, {{2}}... (positional) takes a plain array IN ORDER, e.g.
 *    ["Tirth"] for a body like "Hi {{1}}, ...".
 *  - a template written with {{customer_name}} etc (named - what WhatsApp Manager's template
 *    editor produces by default now) takes a plain object keyed by those names, e.g.
 *    { customer_name: "Tirth" } for a body like "Hi {{customer_name}}, ...".
 * Pass [] (or omit) for a template with no variables (like the built-in "hello_world" sample).
 * Either way, callers never have to know Meta's own verbose parameter object shape
 * ({ type: "text", text: "...", parameter_name?: "..." } per value) - this function builds that. */
export async function sendWhatsAppTemplate(
  to: string,
  name: string,
  languageCode: string,
  bodyVariables: string[] | Record<string, string> = []
): Promise<void> {
  const url = `${GRAPH_BASE}/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;

  const parameters = Array.isArray(bodyVariables)
    ? bodyVariables.map((text) => ({ type: "text", text }))
    : Object.entries(bodyVariables).map(([parameter_name, text]) => ({
        type: "text",
        parameter_name,
        text,
      }));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name,
        language: { code: languageCode },
        // Omit the "components" array entirely for a no-variable template - Meta rejects an empty
        // body component on some template shapes, so this only gets included when there's
        // something to fill in.
        ...(parameters.length > 0 ? { components: [{ type: "body", parameters }] } : {}),
      },
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`WhatsApp template send failed (${res.status}): ${errorBody}`);
  }
}
