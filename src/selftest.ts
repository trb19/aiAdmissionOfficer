// Quick logic sanity check that needs no real credentials - not a real test suite (no framework),
// just a fast way to catch an obviously broken classifier or payload parser before real testing.
import { classifyMessage, feeRedirectReply, needsIntake, intakeAskSuffix, MAX_INTAKE_ATTEMPTS } from "./ai.js";
import { extractInboundMessages, extractInboundAttachments, detectLeadSource, isBrochureRequest } from "./whatsapp.js";
import { matchFaq } from "./faq.js";
import type { FamilyProfile, FaqEntry } from "./db.js";

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} - ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`}`);
  if (!ok) process.exitCode = 1;
}

assertEqual(classifyMessage("What are your fees?"), "FEE_QUESTION", "direct fee question");
assertEqual(classifyMessage("How much does daycare cost per month"), "FEE_QUESTION", "indirect fee question (cost)");
assertEqual(classifyMessage("Is it very expensive"), "ROUTINE", "'expensive' alone should not trip the fee keyword list (documents current behavior, not necessarily final)");
assertEqual(classifyMessage("Can I talk to a person please"), "HUMAN_REQUEST", "human handoff request");
assertEqual(classifyMessage("What age can my daughter join?"), "ROUTINE", "routine eligibility question");

const samplePayload = {
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              { id: "wamid.123", from: "919876543210", timestamp: "1700000000", type: "text", text: { body: "What are your school timings?" } },
            ],
          },
        },
      ],
    },
  ],
};
const extracted = extractInboundMessages(samplePayload);
assertEqual(extracted.length, 1, "extracts one message from sample webhook payload");
assertEqual(extracted[0]?.text, "What are your school timings?", "extracts correct message text");

const statusOnlyPayload = {
  entry: [{ changes: [{ value: { statuses: [{ id: "wamid.456", status: "delivered" }] } }] }],
};
assertEqual(extractInboundMessages(statusOnlyPayload).length, 0, "ignores status-only webhook events");

const payloadWithContact = {
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ wa_id: "919876543210", profile: { name: "Priya Sharma" } }],
            messages: [
              { id: "wamid.789", from: "919876543210", timestamp: "1700000000", type: "text", text: { body: "Hi" } },
            ],
          },
        },
      ],
    },
  ],
};
assertEqual(
  extractInboundMessages(payloadWithContact)[0]?.parentName,
  "Priya Sharma",
  "captures parent's WhatsApp display name from the contacts array"
);
assertEqual(extracted[0]?.parentName, undefined, "parentName is undefined when no contacts array is present");

const emptyProfile: FamilyProfile = { parentName: null, childName: null, childAge: null, intakeAttempts: 0, pausedUntil: null };
const knownProfile: FamilyProfile = { parentName: "Priya", childName: "Aarav", childAge: "3", intakeAttempts: 1, pausedUntil: null };
const exhaustedProfile: FamilyProfile = { parentName: null, childName: null, childAge: null, intakeAttempts: MAX_INTAKE_ATTEMPTS, pausedUntil: null };

assertEqual(needsIntake(emptyProfile), true, "needsIntake is true when child name/age unknown and attempts remain");
assertEqual(needsIntake(knownProfile), false, "needsIntake is false once child name and age are both known");
assertEqual(needsIntake(exhaustedProfile), false, "needsIntake is false once MAX_INTAKE_ATTEMPTS is reached");

const feeReplyUnknown = feeRedirectReply(emptyProfile);
assertEqual(/\d{6,}/.test(feeReplyUnknown), false, "fee reply never contains a phone number when intake is still needed");
assertEqual(feeReplyUnknown.toLowerCase().includes("name"), true, "fee reply asks for child's name when unknown");

const feeReplyKnown = feeRedirectReply(knownProfile);
assertEqual(/\d{6,}/.test(feeReplyKnown), false, "fee reply never contains a phone number once child info is known");
assertEqual(feeReplyKnown.includes("Aarav"), true, "fee reply uses the child's name once known");
assertEqual(feeReplyKnown.toLowerCase().includes("what's"), false, "fee reply does not re-ask once child info is known");

const faqEntries: FaqEntry[] = [
  { id: "age-eligibility", keywords: ["what age", "minimum age"], question: "What age?", answer: "Playgroup is from 18 months..." },
  { id: "location", keywords: ["your address", "where are you located"], question: "Where are you?", answer: "Bylane 3, Baroholia, Tezpur." },
];

assertEqual(matchFaq("What age can my son join?", faqEntries)?.id, "age-eligibility", "matches FAQ by keyword phrase regardless of exact wording");
assertEqual(matchFaq("Where are you located?", faqEntries)?.id, "location", "matches a second FAQ entry independently");
assertEqual(matchFaq("Do you have a swimming pool?", faqEntries), null, "returns null when nothing matches, so the caller falls through to the AI");

assertEqual(intakeAskSuffix(emptyProfile) !== null, true, "intakeAskSuffix returns something when intake is still needed");
assertEqual(intakeAskSuffix(knownProfile), null, "intakeAskSuffix returns null once child info is known");
assertEqual(intakeAskSuffix(exhaustedProfile), null, "intakeAskSuffix returns null once attempts are exhausted");

// Non-text messages (photos, voice notes, button taps) are saved for the /inbox page but never
// answered by the bot - extractInboundMessages must keep ignoring them, extractInboundAttachments
// must pick them up with a readable label.
const mixedPayload = {
  entry: [{ changes: [{ value: {
    contacts: [{ wa_id: "919876543210", profile: { name: "Priya" } }],
    messages: [
      { id: "wamid.t1", from: "919876543210", timestamp: "1700000000", type: "text", text: { body: "Hello" } },
      { id: "wamid.a1", from: "919876543210", timestamp: "1700000001", type: "audio", audio: { id: "m1" } },
      { id: "wamid.i1", from: "919876543210", timestamp: "1700000002", type: "image", image: { id: "m2", caption: "School gate?" } },
      { id: "wamid.b1", from: "919876543210", timestamp: "1700000003", type: "button", button: { text: "Book a visit" } },
    ],
  } }] }],
};
assertEqual(extractInboundMessages(mixedPayload).length, 1, "text extractor still ignores photos/voice notes/buttons");
const attachments = extractInboundAttachments(mixedPayload);
assertEqual(attachments.map((a) => a.label), ["[Voice note]", "[Photo] School gate?", "[Button] Book a visit"], "attachments get readable inbox labels");
assertEqual(attachments[0]?.parentName, "Priya", "attachment keeps the sender's WhatsApp name");
assertEqual(extractInboundAttachments(statusOnlyPayload).length, 0, "status callbacks are not treated as attachments");

console.log("Self-test complete.");

// Lead source for the CRM's Source column (new leads only).
assertEqual(detectLeadSource({ type: "text", text: { body: "Hi Glo! I would like to book a school visit." } }), "Website", "website button pre-fill -> Website");
assertEqual(detectLeadSource({ type: "text", text: { body: "Hello, fees? (website)" } }), "Website", "(website) marker -> Website");
assertEqual(detectLeadSource({ type: "text", text: { body: "Hi" }, referral: { source_type: "ad", source_url: "https://fb.me/abc" } }), "Facebook Ads", "click-to-WhatsApp ad referral -> Facebook Ads");
assertEqual(detectLeadSource({ type: "text", text: { body: "Hi" }, referral: { source_type: "ad", source_url: "https://www.instagram.com/p/xyz" } }), "Insta Ads", "Instagram ad referral -> Insta Ads");
assertEqual(detectLeadSource({ type: "text", text: { body: "Hi, admission for my son" } }), undefined, "plain chat -> no source (stays Whatsapp)");

// Brochure on request.
assertEqual(isBrochureRequest("Can you send me the brochure?"), true, "brochure request");
assertEqual(isBrochureRequest("Do you have a prospectus or PDF"), true, "prospectus / pdf request");
assertEqual(isBrochureRequest("What are the timings?"), false, "ordinary question is not a brochure request");

// --- Lead check (A5) and Meta lead forms (A2) ---
import { scoreLead, parseAgeYears, indianMobile, isJunkName } from "./leadQuality.js";
import { extractLeadgenEvents, parseMetaLeadFields } from "./metaLeads.js";
import { mergeQuality } from "./sheets.js";

const nov2026 = new Date(2026, 10, 20);
assertEqual(indianMobile("+91 98640 12345"), "9864012345", "indianMobile strips +91 and spaces");
assertEqual(indianMobile("03712 221234"), "", "landline is not a mobile");
assertEqual(isJunkName("asdf"), true, "junk name asdf");
assertEqual(isJunkName("Priyanka Das"), false, "real name passes");
assertEqual(isJunkName("😊"), true, "emoji-only name is junk on a form");
assertEqual(parseAgeYears("3 years 6 months", nov2026), 3.5, "age: years + months");
assertEqual(parseAgeYears("18 months", nov2026), 1.5, "age: months");
assertEqual(parseAgeYears("2022", nov2026), 4, "age: birth year");
assertEqual(Math.floor(parseAgeYears("15/06/2023", nov2026) ?? 0), 3, "age: date of birth");
assertEqual(parseAgeYears("not sure", nov2026), null, "age: unreadable");
assertEqual(scoreLead({ phone: "9999999999", name: "Rahul" }).quality, "Spam", "repeated-digit phone is Spam");
assertEqual(scoreLead({ phone: "12345", name: "Rahul" }).quality, "Spam", "short phone is Spam");
assertEqual(scoreLead({ phone: "9864012345", name: "test" }).quality, "Spam", "name 'test' is Spam");
assertEqual(scoreLead({ phone: "9864012345", name: "Rahul", email: "x@mailinator.com" }).quality, "Spam", "throwaway email is Spam");
assertEqual(scoreLead({ phone: "9864012345", name: "Rahul", honeypot: "http://spam" }).quality, "Spam", "filled spam trap is Spam");
assertEqual(scoreLead({ phone: "9864012345", name: "Rahul", childAge: "3" }).quality, "Warm", "valid form lead is Warm");
assertEqual(scoreLead({ phone: "9864012345", name: "Rahul", childAge: "9 years" }).quality, "Cold", "age 9 is Cold");
assertEqual(scoreLead({ phone: "9864012345", name: "Rahul", area: "Guwahati 781006" }).quality, "Cold", "PIN outside 784 is Cold");
assertEqual(scoreLead({ phone: "9864012345", name: "Rahul", area: "Tezpur 784001" }).reasons.includes("local area"), true, "784 PIN counts as local");
assertEqual(scoreLead({ phone: "919864012345", name: "😊", repliedOnWhatsApp: true }).quality, "Hot", "WhatsApp chat is Hot even with an emoji name");
assertEqual(scoreLead({ phone: "919864012345", childAge: "10", repliedOnWhatsApp: true }).quality, "Cold", "WhatsApp chat about a 10-year-old is Cold");
assertEqual(mergeQuality("", "Hot"), "Hot", "blank label takes the new one");
assertEqual(mergeQuality("Warm", "Hot"), "Hot", "a reply upgrades Warm to Hot");
assertEqual(mergeQuality("Spam", "Hot"), "Spam", "a label staff set to Spam stays");
assertEqual(mergeQuality("Cold", "Hot"), "Cold", "a Cold label stays");

const leadgenBody = { object: "page", entry: [{ id: "111", changes: [{ field: "leadgen", value: { leadgen_id: "444", page_id: "111", form_id: "222" } }] }] };
assertEqual(extractLeadgenEvents(leadgenBody).map((e) => e.leadgenId), ["444"], "extracts leadgen id from a Page webhook");
assertEqual(extractLeadgenEvents(samplePayload).length, 0, "WhatsApp webhook has no leadgen events");
const parsedLead = parseMetaLeadFields([
  { name: "full_name", values: ["Anita Bora"] },
  { name: "phone_number", values: ["+919864012345"] },
  { name: "city", values: ["Tezpur"] },
  { name: "child's_age", values: ["3 years"] },
  { name: "preferred_visit_day?", values: ["Saturday"] },
]);
assertEqual([parsedLead.name, parsedLead.phone, parsedLead.city, parsedLead.childAge], ["Anita Bora", "+919864012345", "Tezpur", "3 years"], "maps Meta lead form answers");
assertEqual(parsedLead.extras, ["preferred visit day: Saturday"], "keeps other answers as extras");
