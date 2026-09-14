/**
 * Approved GLO facts for the AI to draw on when answering parents.
 *
 * IMPORTANT: fee figures are deliberately NOT included here. GLO's policy (confirmed 13 Sept 2026)
 * is that fees are discussed over a phone call, not quoted by the AI on WhatsApp. Keeping fee
 * numbers out of this file entirely is a deliberate second line of defense on top of the
 * keyword-based redirect in ai.ts's classifyMessage() â even if a fee question slips past that
 * classifier, the model has no fee figures available to leak.
 *
 * Everything else here is either sourced from GLO's own documents (Parent Handbook 2026, the
 * fee-structure doc's non-fee sections) or confirmed directly by Tirth on 13 Sept 2026. See the
 * "AI Admission Officer" project's glo-approved-facts-draft.md for the full sourcing and the
 * open items not yet resolved (per-class age cutoffs, next session's dates, visit capacity).
 *
 * Update this file, not the AI's behavior, whenever GLO confirms a new fact â that's the point of
 * keeping facts and the answering logic separate.
 */
export const GLO_APPROVED_FACTS = `
School: GLO Preschool & Daycare, Bylane 3, Baroholia, Tezpur, Assam.
Google Maps location: https://maps.app.goo.gl/rsHjmAdNVXp3MCqBA

Programs: Playgroup, Nursery, Jr. KG, Sr. KG (preschool track), plus a separate Daycare program.
Play-based early-years curriculum; English is the medium of instruction, with
Assamese/Hindi/English all fine for parent communication. Children begin alphabet/number
recognition from Playgroup and read/write independently by the time they finish Sr. KG.
Student-teacher (student-staff) ratio: 5:1.

Age eligibility (confirmed 14 Sept 2026, measured as of 1st April of the academic year, and
described as "ideal" bands rather than a rigid rule): Playgroup from 18 months, Nursery from 3
years, Jr. KG from 4 years, Sr. KG from 5 years. Daycare separately accepts children from 1 year
of age. Since these are ideal bands and not a strict cutoff, if a parent asks which specific class
their child would join, you can name the class their age band points to, but also say a staff
member will confirm the exact placement based on the child's date of birth.

Timings (confirmed 14 Sept 2026): School (Playgroup/Nursery/Jr. KG/Sr. KG) 9:30am-12:30pm. Daycare
8:30am-5:30pm. Office 9:00am-4:00pm.

Visits: visits happen 1:00pm-3:00pm, by appointment - never just say "by appointment" and stop
there. Ask the parent when they're planning to visit, so the school can schedule it and mark the
calendar.

Fees: never state a fee amount, monthly/annual figure, or Daycare-slab price yourself, however the
question is phrased (including indirect phrasing like "how much", "what's the cost", "is it
expensive"). Always say our admission coordinator will get in touch with them for the details -
never redirect to a phone number for fee questions specifically.

Office hours: 9:00am-4:00pm (see Timings above; office hours were previously stated as 9-5, now
corrected to 9-4).

Escalation / more help: for anything you cannot answer confidently, or if a parent asks for a
person, direct them to call ${"__ESCALATION_PHONE__"}.
`.trim();

export function factsWithEscalationNumber(escalationPhone: string): string {
  return GLO_APPROVED_FACTS.replaceAll("__ESCALATION_PHONE__", escalationPhone);
}
