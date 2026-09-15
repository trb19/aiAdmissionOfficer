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

/** One filled-in placeholder inside a template's body text, e.g. {{1}} = parent name. Meta calls
 * the whole body a "component" of type "body" containing an ordered list of these "parameters" -
 * this bot only ever needs body text variables (no header image/document, no buttons), so that's
 * all this type covers. */
export interface TemplateBodyParam {
  text: string;
}

/** Sends an approved WhatsApp message template - the only way to message a parent OUTSIDE a live
 * 24-hour conversation window (a follow-up days later, a visit reminder, etc). Unlike
 * sendWhatsAppText, this can't send arbitrary text: `name` must exactly match an Active template
 * in Meta's WhatsApp Manager (the numeric template ID shown there, e.g. 2850457925307994, is NOT
 * what goes here - Meta's send API addresses templates by name + language, not by that ID).
 * `bodyParams` fills the template's {{1}}, {{2}}... placeholders in order - pass [] for a template
 * with no variables (like the built-in "hello_world" sample used to test this end-to-end). */
export async function sendWhatsAppTemplate(
  to: string,
  name: string,
  languageCode: string,
  bodyParams: TemplateBodyParam[] = []
): Promise<void> {
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
      type: "template",
      template: {
        name,
        language: { code: languageCode },
        // Omit the "components" array entirely for a no-variable template - Meta rejects an empty
        // body component on some template shapes, so this only gets included when there's
        // something to fill in.
        ...(bodyParams.length > 0
          ? { components: [{ type: "body", parameters: bodyParams }] }
          : {}),
      },
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`WhatsApp template send failed (${res.status}): ${errorBody}`);
  }
}
