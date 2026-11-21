// Lead check: labels every new lead Hot / Warm / Cold / Spam so staff call the real parents first.
// The same rules live in crm/Code.gs (scoreLead_) for website and Google form leads - keep the two
// in step if either changes.
//
//   Spam  junk or invalid phone, junk name, throwaway email, spam-trap field filled, no contact.
//         Skipped for a parent who messaged on WhatsApp: WhatsApp has already proved the number.
//   Cold  child's age outside 1 to 6.5 years, or a PIN code outside the 784xxx (Sonitpur) area.
//   Hot   the parent has written to us on WhatsApp (the strongest sign of a real lead).
//   Warm  everything else (a valid form lead that hasn't replied yet).

export type LeadQuality = "Hot" | "Warm" | "Cold" | "Spam";

export interface LeadCheckInput {
  phone?: string;
  name?: string;
  email?: string;
  childAge?: string;
  /** City, address and/or PIN code, as typed. */
  area?: string;
  /** Value of a hidden spam-trap field; real people never fill it. */
  honeypot?: string;
  repliedOnWhatsApp?: boolean;
}

export interface LeadCheck {
  quality: LeadQuality;
  reasons: string[];
}

/** Last 10 digits if they form a valid Indian mobile number (starts 6-9), else "". */
export function indianMobile(phone: string | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  const ten = digits.length > 10 && /^(91|0)/.test(digits) ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? ten : "";
}

const JUNK_NUMBERS = new Set(["1234567890", "9876543210", "0123456789", "9123456789", "9999988888", "9988776655"]);

function isJunkMobile(ten: string): boolean {
  return /^(\d)\1{9}$/.test(ten) || /^(\d)\1{6,}/.test(ten) || JUNK_NUMBERS.has(ten);
}

const JUNK_NAMES = /^(test|testing|tester|asdf\w*|qwerty|abc|abcd|xyz|na|n\/a|none|null|nil|fake|demo|sample|hello|hi|hii|ok|aaa+|xxx+|zzz+|sdf\w*)$/i;

export function isJunkName(name: string | undefined): boolean {
  const n = String(name ?? "").trim();
  if (!n) return false; // a missing name is not proof of spam
  if (!/\p{L}/u.test(n)) return true; // digits or symbols only
  if (JUNK_NAMES.test(n)) return true;
  const letters = n.replace(/[^a-z]/gi, "");
  return letters.length >= 5 && !/[aeiouy]/i.test(letters); // keyboard mash like "sdfghk"
}

const THROWAWAY_EMAIL = /@(mailinator|guerrillamail|sharklasers|10minutemail|tempmail|temp-mail|yopmail|trashmail|getnada|dispostable|maildrop|fakeinbox|throwawaymail)\./i;

/** Child's age in years from free text: "3", "2.5 yrs", "3 years 4 months", "18 months", a
 * birth year ("2022") or a date of birth ("12/05/2022"). null when it can't tell. */
export function parseAgeYears(text: string | undefined, now: Date = new Date()): number | null {
  const t = String(text ?? "").toLowerCase().trim();
  if (!t) return null;
  const thisYear = now.getFullYear();

  const dob = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/);
  if (dob) {
    const born = new Date(Number(dob[3]), Number(dob[2]) - 1, Number(dob[1]));
    if (!isNaN(born.getTime())) return (now.getTime() - born.getTime()) / (365.25 * 864e5);
  }
  const yearOnly = t.match(/\b(20\d{2})\b/);
  if (yearOnly && Number(yearOnly[1]) <= thisYear) return thisYear - Number(yearOnly[1]);

  const ym = t.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|y)\b\D*(\d+)\s*(?:months?|mons?|mths?|m)\b/);
  if (ym) return Number(ym[1]) + Number(ym[2]) / 12;
  const months = t.match(/(\d+(?:\.\d+)?)\s*(?:months?|mons?|mths?|mos?)\b/);
  if (months) return Number(months[1]) / 12;
  const years = t.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|y)?\b/);
  if (years && Number(years[1]) <= 12) return Number(years[1]);
  return null;
}

const MIN_AGE = 1; // Daycare takes children from 1 year
const MAX_AGE = 6.5; // Sr. KG is the last class

function ageLabel(years: number): string {
  return years < 2 ? `${Math.round(years * 12)} months` : `${Math.round(years * 10) / 10} years`;
}

export function scoreLead(input: LeadCheckInput): LeadCheck {
  const spam: string[] = [];
  const cold: string[] = [];
  const good: string[] = [];

  if (!input.repliedOnWhatsApp) {
    const mobile = indianMobile(input.phone);
    if (input.phone && !mobile) spam.push("phone is not a valid Indian mobile");
    else if (mobile && isJunkMobile(mobile)) spam.push("phone looks made up");
    else if (mobile) good.push("valid mobile");
    if (!input.phone && !input.email) spam.push("no phone or email");
    if (isJunkName(input.name)) spam.push(`name looks fake ("${String(input.name).trim()}")`);
    if (input.email && THROWAWAY_EMAIL.test(input.email)) spam.push("throwaway email address");
    if (input.honeypot && input.honeypot.trim()) spam.push("spam-trap field was filled (a bot)");
  }
  if (spam.length) return { quality: "Spam", reasons: spam };

  const age = parseAgeYears(input.childAge);
  if (age !== null) {
    if (age < MIN_AGE || age > MAX_AGE) cold.push(`child is ${ageLabel(age)}, outside 1 to 6½ years`);
    else good.push(`child ${ageLabel(age)} fits`);
  }
  const area = String(input.area ?? "");
  const pin = area.match(/\b(\d{6})\b/);
  if (pin && !pin[1].startsWith("784")) cold.push(`PIN ${pin[1]} is outside Sonitpur`);
  else if (pin || /tezpur|sonitpur|dhekiajuli|balipara|rangapara|misamari|biswanath|jamugurihat|bihaguri/i.test(area)) {
    good.push("local area");
  }
  if (cold.length) return { quality: "Cold", reasons: cold };

  if (input.repliedOnWhatsApp) return { quality: "Hot", reasons: ["messaged on WhatsApp", ...good] };
  return { quality: "Warm", reasons: good.length ? good : ["no reply on WhatsApp yet"] };
}

/** "Lead check: Warm (valid mobile, child 3 years fits)" - the line that goes into Remarks. */
export function describeLeadCheck(check: LeadCheck): string {
  return `Lead check: ${check.quality}${check.reasons.length ? ` (${check.reasons.join(", ")})` : ""}`;
}
