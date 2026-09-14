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
  using the parent's recent message history (`src/db.ts`) so it can follow a back-and-forth
  instead of treating every message as a fresh conversation, with instructions to say "not sure,
  please call" rather than guess.

Every enquiry — question and reply — is logged as a new row in the existing "GLO Preschool -
Admission CRM" Google Sheet, with a classification column so staff can filter for fee/human-request
rows that likely need a follow-up call. A second "Conversations" tab (created automatically) keeps
one row per parent phone number with a short running summary of that whole chat, refreshed after
every message, for a quick-glance view instead of scrolling through every individual row.

## What it deliberately does NOT do yet

No visit booking, no lead scoring/CRM state machine, no multi-tenant support (this only works for
GLO), no message templates or proactive follow-ups, no handling of images/voice notes/attachments
(a message like that is simply not picked up — see `extractInboundMessages` in `src/whatsapp.ts`).
No persistent dedup store — message-ID dedup is in-memory, which is fine for one instance and gets
reset on every restart (documented in `src/server.ts`, this is a known Phase 1 upgrade; note this
is separate from conversation *history*, which now lives in Postgres and does survive restarts).
These are intentional cuts to keep Phase 0 buildable in days, not months — see the roadmap doc for
what Phase 1 adds back in.

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

On a host with no persistent disk (Render's free tier, for example), skip saving the file locally
and instead paste the entire JSON key's contents as one line into `GOOGLE_SERVICE_ACCOUNT_KEY_JSON`
— see the comment in `.env.example`. That env var takes priority over the file path when both are
set.

### 5. Conversation memory (Postgres)

The bot keeps a short history of each parent's conversation so it can handle follow-up questions
instead of answering every message cold. This is stored in Postgres, not in-memory, so it survives
restarts and Render's free-tier spin-downs.

1. In the Render dashboard: New > PostgreSQL, free tier is fine for Phase 0's volume.
2. Copy its "Internal Database URL" (if the bot runs on Render too) or "External Database URL"
   (for local dev) into `DATABASE_URL`.
3. No manual schema setup needed — `src/db.ts` creates its tables automatically on first use.

### 6. Run it locally and expose it to the internet for testing

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

### 7. Configure the webhook in Meta

In the "Glo Messenger" app (Meta for Developers) → WhatsApp → Configuration → Webhooks:

- Callback URL: `https://<your-tunnel-or-host>/webhook`
- Verify token: the same string you put in `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the `messages` field

Also: the app needs to be **published** (Meta for Developers > App Settings) before it can receive
any real webhook traffic — an unpublished app only gets test pings from the dashboard, not real
messages. See `meta-whatsapp-setup-checklist.md` for the current status of this.

### 8. Test end to end

Send a WhatsApp message to GLO's number from your own phone and confirm: you get a reply, a new
row appears in the "Admission Queries" tab of the CRM sheet, and a row for that phone number
appears (or updates) in the "Conversations" tab. Then send a follow-up message that only makes
sense with context (e.g. ask about age eligibility, then ask "what about for Daycare instead?")
and confirm the reply actually understands what "instead" refers to.
