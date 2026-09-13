# GLO Admissions Bot — Phase 0

A minimal WhatsApp FAQ bot for GLO Preschool, built to validate one thing before any bigger
investment: will parents actually engage over WhatsApp, and is the enquiry log useful to staff?
No visit booking, no lead scoring, no multi-tenancy — see the "AI Admission Officer" project's
`brainstorm-and-build-roadmap.md` for why this is deliberately small.

## What it does

A parent messages GLO's WhatsApp number. This service receives it via a webhook, decides which of
three things to do, and replies:

- **Fee question** (any mention of fees/cost/price/tuition/payment) → a scripted reply directing
  the parent to call, never a number quoted by the AI. This is a GLO policy decision (confirmed
  13 Sept 2026), not a technical limitation — see `src/facts.ts` for why fee figures are kept out
  of the AI's context entirely as a second line of defense.
- **Asking for a person** → a scripted reply with the phone number and office hours.
- **Everything else** → Gemini answers from a fixed set of GLO-approved facts (`src/facts.ts`),
  with instructions to say "not sure, please call" rather than guess.

Every enquiry — question and reply — is logged as a new row in the existing "GLO Preschool -
Admission CRM" Google Sheet, with a classification column so staff can filter for fee/human-request
rows that likely need a follow-up call.

## What it deliberately does NOT do yet

No visit booking, no lead scoring/CRM state machine, no multi-tenant support (this only works for
GLO), no message templates or proactive follow-ups, no handling of images/voice notes/attachments
(a message like that is simply not picked up — see `extractInboundMessages` in `src/whatsapp.ts`).
No persistent dedup store — message-ID dedup is in-memory, which is fine for one instance and gets
reset on every restart (documented in `src/server.ts`, this is a known Phase 1 upgrade). These are
intentional cuts to keep Phase 0 buildable in days, not months — see the roadmap doc for what
Phase 1 adds back in.

## Setup

### 1. Install dependencies

```
npm install
```

### 2. WhatsApp credentials

Copy `.env.example` to `.env`. `WHATSAPP_PHONE_NUMBER_ID` is already pre-filled with the ID for
GLO's connected number (+91 91012 09309) found in WhatsApp Manager. You need to fill in:

- `WHATSAPP_TOKEN` — the permanent system-user token generated in Meta Business Settings > Users >
  System Users (see the project's `meta-whatsapp-setup-checklist.md` for exactly where).
- `WHATSAPP_VERIFY_TOKEN` — make up any random string; you'll enter this same string into Meta's
  webhook config screen in step 5.

### 3. Gemini API key

Get a free-tier key at https://aistudio.google.com/app/apikey and put it in `GEMINI_API_KEY`.

### 4. Google Sheets logging

This needs a Google Cloud **service account** (a robot identity, separate from your own Google
login) with access to just the one sheet:

1. Go to https://console.cloud.google.com, create a project (or reuse one), and enable the
   "Google Sheets API" for it.
2. Create a service account (IAM & Admin > Service Accounts > Create Service Account). No special
   role is needed at the project level — access is granted per-sheet in step 4.
3. Create a JSON key for that service account and download it. Save it as
   `service-account.json` in this project folder (already in `.gitignore` — never commit it).
4. Open the "GLO Preschool - Admission CRM" sheet, click Share, and share it with the service
   account's email address (looks like `something@your-project.iam.gserviceaccount.com`, found in
   the downloaded JSON as `client_email`) with Editor access.

### 5. Run it locally and expose it to the internet for testing

```
npm run dev
```

This starts the server on `PORT` (default 3000), but Meta needs a public HTTPS URL to send
webhooks to — your laptop's localhost isn't reachable from Meta's servers. For testing, use a
tunnel tool (e.g. `npx cloudflared tunnel --url http://localhost:3000`, or ngrok) to get a
temporary public URL. Remember: the old prototype's tunnel URL died when its tunnel process
stopped — the same will happen to yours the moment you close the terminal, and it'll need
reconfiguring in Meta each time. For anything beyond quick local testing, deploy this somewhere
that gives a stable URL (Render, Railway, Fly.io all have workable free/cheap tiers) rather than
relying on a tunnel long-term.

### 6. Configure the webhook in Meta

In the "Glo Messenger" app (Meta for Developers) → WhatsApp → Configuration → Webhooks:

- Callback URL: `https://<your-tunnel-or-host>/webhook`
- Verify token: the same string you put in `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the `messages` field

Also: the app needs to be **published** (Meta for Developers > App Settings) before it can receive
any real webhook traffic — an unpublished app only gets test pings from the dashboard, not real
messages. See `meta-whatsapp-setup-checklist.md` for the current status of this.

### 7. Test end to end

Send a WhatsApp message to GLO's number from your own phone and confirm: you get a reply, and a
new row appears in the "Admission Queries" tab of the CRM sheet.
