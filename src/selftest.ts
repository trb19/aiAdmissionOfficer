// Quick logic sanity check that needs no real credentials - not a real test suite (no framework),
// just a fast way to catch an obviously broken classifier or payload parser before real testing.
import { classifyMessage, feeRedirectReply, needsIntake, intakeAskSuffix, MAX_INTAKE_ATTEMPTS } from "./ai.js";
import { extractInboundMessages } from "./whatsapp.js";
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

console.log("Self-test complete.");
