/**
 * Approved GLO facts for the AI to draw on when answering parents.
 *
 * IMPORTANT: fee figures are deliberately NOT included here. GLO's policy (confirmed 13 Sept 2026)
 * is that fees are discussed over a phone call, not quoted by the AI on WhatsApp. Keeping fee
 * numbers out of this file entirely is a deliberate second line of defense on top of the
 * keyword-based redirect in ai.ts's classifyMessage() — even if a fee question slips past that
 * classifier, the model has no fee figures available to leak.
 *
 * Everything else here is either sourced from GLO's own documents (Parent Handbook 2026, the
 * fee-structure doc's non-fee sections) or confirmed directly by Tirth on 13 Sept 2026. See the
 * "AI Admission Officer" project's glo-approved-facts-draft.md for the full sourcing and the
 * open items not yet resolved (per-class age cutoffs, next session's dates, visit capacity).
 *
 * Update this file, not the AI's behavior, whenever GLO confirms a new fact — that's the point of
 * keeping facts and the answering logic separate.
 */
export const GLO_APPROVED_FACTS = `
School: GLO Preschool & Daycare, Bylane 3, Baroholia, Tezpur, Assam.

Programs: Playgroup, Nursery, Jr. KG, Sr. KG (preschool track), plus a separate Daycare program
(timings 8:30am-5:30pm). Play-based early-years curriculum; English is the medium of instruction,
with Assamese/Hindi/English all fine for parent communication. Children begin alphabet/number
recognition from Playgroup and read/write independently by the time they finish Sr. KG.

Age eligibility (confirmed floors only - do not state exact per-class cutoff dates, they are not
yet finalized): Daycare accepts children from 1 year of age. The Preschool track (Playgroup and
up) accepts children from 18 months. If a parent asks which specific class (Playgroup / Nursery /
Jr. KG / Sr. KG) their child would join, say that a staff member can confirm the exact placement
based on the child's date of birth - do not guess a specific class yourself.

Visits: visits happen 1:00pm-3:00pm, by appointment (call ahead to book, not a walk-in window).

Fees: never state a fee amount, monthly/annual figure, or Daycare-slab price yourself, however the
question is phrased (including indirect phrasing like "how much", "what's the cost", "is it
expensive"). Always say fee details are best discussed on a call, and give the escalation phone
number.

Office hours: 9:00am-5:00pm, Monday-Saturday (closed Sundays).

Escalation / more help: for anything you cannot answer confidently, or if a parent asks for a
person, direct them to call ${"__ESCALATION_PHONE__"}.
`.trim();

export function factsWithEscalationNumber(escalationPhone: string): string {
  return GLO_APPROVED_FACTS.replaceAll("__ESCALATION_PHONE__", escalationPhone);
}
