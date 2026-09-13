// Quick logic sanity check that needs no real credentials - not a real test suite (no framework),
// just a fast way to catch an obviously broken classifier or payload parser before real testing.
import { classifyMessage } from "./ai.js";
import { extractInboundMessages } from "./whatsapp.js";

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

console.log("Self-test complete.");
