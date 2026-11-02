# Backstop

When an event is cancelled, one organizer suddenly owes hundreds of people money, some of it already spent on deposits. Backstop gets them through it. A live dashboard shows what is owed and what can be covered, and an AI agent drafts refunds, vendor payments and chargeback answers. Real PayPal sandbox money moves only after the organizer approves a slip.

Built for the PayPal AI Hackathon with the PayPal developer platform, Groq and AG Studio.

**Try it:** https://backstop-zeta.vercel.app

## The problem

A small organizer sells tickets through PayPal, then spends part of that money on venue and vendor deposits. When a storm cancels the event, everyone wants their money at once, and the cash on hand no longer covers it. Pausing to work it out invites chargebacks. Refunding carelessly can pay someone twice.

## Try the demo

No login is needed. The hosted demo runs on the PayPal sandbox with invented attendees.

1. Open the site. If the current event is finished, click **Start a new event**. This sells 24 tickets through PayPal and takes about 20 seconds.
2. Click **Cancel the event**. Attendee replies are simulated, and two attendees go straight to their card company.
3. Click **Ask the agent what to do**. It reads the numbers and drafts a slip.
4. Approve the slip. Real sandbox refunds run, and any refund cash cannot cover stays held back.
5. Ask the agent for a chart, such as "show how many attendees are in each status".
6. After a few minutes, chargebacks are ready to answer. Click **Draft an answer**, then approve it.

Each attendee has a ticket page at `/t/<token>`, where they choose a refund or keep their ticket for the new date.

## How PayPal is used

PayPal is the system of record for every dollar on screen.

| PayPal API | What it does here |
|---|---|
| Orders v2 | Sells each ticket as a real captured payment |
| Payments v2 | Issues refunds, with a stable `PayPal-Request-Id` so a retry cannot pay twice |
| Payouts | Pays vendors |
| Disputes v1 | Reads chargebacks, submits evidence, and accepts claims |
| Webhooks | Receives dispute, refund and payout events, and verifies each signature with PayPal |

Two sandbox-only Disputes endpoints support the demo: `process-chargeback` raises a chargeback without a buyer login, and `adjudicate` stands in for PayPal's decision. The screen labels the second one as sandbox only.

## How AI is used

The agent runs on AG Studio's agent harness and calls Groq's `openai/gpt-oss-120b`, with Gemini's free tier as an automatic backup. It has five tools: read the situation, draft refunds, draft a vendor payment, draft a chargeback answer, and add a chart to the dashboard.

The agent proposes and the server decides. Rules in `lib/gate.ts` and `lib/proposals.ts` are plain code the model cannot talk its way past:

- No tool can move money. Only an approved slip can.
- A ticket can sit on one waiting slip at a time.
- Cash on a waiting slip is reserved, and cash is rechecked at approval.
- An open chargeback blocks a refund, so nobody is paid twice.
- Attendees come before vendors while cash is short.
- The app, not the model, decides whether to accept or contest a chargeback.

## Run it locally

You need Node 22 and a PayPal sandbox **Business account registered in the US**. Sandbox accounts in some other countries cannot take card payments or send payouts.

```bash
npm install
cp .env.example .env
npm run dev
```

Fill in `.env`, then open http://localhost:3000. Without `DATABASE_URL` the app stores data in a local PGlite database. Without an AI key the dashboard and slips still work, and the agent says it is unavailable.

| Variable | Purpose |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | From a sandbox app at developer.paypal.com |
| `PAYPAL_BASE_URL` | `https://api-m.sandbox.paypal.com` |
| `PAYPAL_WEBHOOK_ID` | Optional. Needed to verify webhooks on a public URL |
| `GROQ_API_KEY`, `GEMINI_API_KEY` | Free keys for the agent. Either one works |
| `AG_STUDIO` | AG Studio licence key. Without it, Studio shows a watermark |
| `DATABASE_URL` | Optional. A Postgres connection string, such as Neon |

Run the tests with `npm test`.

## Project layout

```
lib/gate.ts          Money rules, as pure functions
lib/proposals.ts     The only code that moves money
lib/chargebacks.ts   Accept or contest, and answering PayPal
lib/paypal.ts        Every PayPal call. Refuses to run outside the sandbox
lib/llm.ts           Free AI providers, tried in order
app/command/         Organizer dashboard, agent and slips
app/t/[token]/       Attendee ticket page
```

## Limits

- This is sandbox only. Attendees and vendors are invented, and attendee replies in the demo are simulated.
- AG Studio is a commercial product used here on a trial licence. The MIT licence covers this project's code, not AG Studio.
- Accept or contest is a simple rule for this demo, and is not legal or financial advice.
