# Banacraft - Ingatlankiürítés, lomtalanítás és takarítás árbecslő

A Hungarian chat widget for the Banacraft kiürítés site. The visitor answers a
short set of questions (clicking buttons **or** typing), leaves their details in
one form, and immediately sees an **itemised starting price** ("alapár … Ft-tól")
with the exclusions named. Banacraft gets the lead and the whole conversation by
e-mail, and conversations that stop halfway are e-mailed too.

One of three separate bots (`banacraft-kiurites-agent`, `banacraft-bontas-agent`,
`banacraft-palateto-agent`). They share the same engine; only `lib/flow.js`, the
`BOT` block at the top of `public/widget.js`, the colour variables at the top of
`public/style.css` and the logos differ.

## How it works

```
public/widget.js ──POST──► api/faq-agent.js (shared engine)
                               ├── lib/flow.js   questions, buttons, price model, company facts
                               ├── OpenAI/Gemini only for TYPED messages the engine can't map
                               ├── Resend        e-mail to Banacraft
                               └── Zoho Flow     CRM webhook (optional)
```

- **The backend owns the conversation.** It picks the next question, words it,
  shows its buttons and maps the click. A click never costs a model call, so the
  bot answers instantly and the buttons can never drift from the question.
- **The AI is only for typed messages** - a question of the visitor's own, or an
  answer in their own words ("harmadik emelet, nincs lift"). It replies and tags
  which option the words meant; the engine validates the tag.
- **No AI key? Still works.** Every button path works; a typed message the engine
  can't read gets "please pick a button, or call us".

## The questions

Munka → helyszín → alapterület → telítettség → emelet / lift (lakás, ház) →
veszélyes hulladék → kezdés. Telek, udvar: mennyiség m³-ben az alapterület
helyett. Takarítás and illegálisan lerakott hulladék ask only the basics and end
in a call.

## Keeping customers in the chat

- **Back** on every question and on the form; **resume** after a reload (kept in
  sessionStorage, gone when the tab closes).
- **A failed request** is retried once quietly; after that the customer's buttons
  or the form (with what they typed) come back.
- **"Inkább visszahívást kérek"** under the chat sends the owner a "VISSZAHÍVÁS"
  e-mail with the answers so far. It does not go to Zoho Flow: that webhook
  expects a priced quote.
- **Under the finished quote:** survey-time buttons and a tap-to-call button. A
  picked time e-mails the owner.
- **Typed answers** that are a button in other words (no accents, "igen", the
  start of one label) are read without a model call. Typed start dates are judged
  against today: "télen" is fine in October, "tavasszal" is not.
- **AI:** 8 s timeout, then the other provider if its key is set, then the buttons.
  A price in the model's reply is replaced before the customer sees it.
- **Analytics (PostHog):** `step_shown` and `question_answered` carry `field`, so
  drop-off shows per question. Also `back_clicked`, `callback_opened`,
  `callback_requested`, `form_submitted`, `form_error`, `survey_time_picked`,
  `call_cta_clicked`, `chat_resumed`.
- **Region:** `vercel.json` runs the function in `fra1` (Frankfurt), close to the
  customers.

## Pricing

- **Banacraft's own prices** (Róbert, 2026-10-30 and 2026-11-05), all in `P`
  at the top of `lib/flow.js`. The full list and the decisions behind it are in
  `banacraft-arak-2026-10-30.md` next to the three bot folders.
- **A floor, never a range.** A band button is priced at its lower edge and the
  assumption is printed; a typed number is priced as typed.
- **Every quantity question** has buttons AND a field for the exact number
  ("pontosan lehessen beírni a számokat").
- **Location first:** Budapest / Pest megye / Pest környéki megye / Távolabb.
  "Távolabb" skips straight to the start date and gets a call, not a price.
- **Start within 60 days** (Amint lehet / 30 / 60 napon belül); a typed later
  start is politely refused.
- **No price, a call instead** for the jobs listed below: the customer sees why
  and "kollégánk hamarosan hívja"; the owner gets a "Hívást kér" e-mail with the
  answers and, where there is a rate, Róbert's figure for the call. Zoho gets
  `quote_basis: "call"` and no amounts.
- **VAT:** magánszemély and társasház see gross, cég and intézmény see net + ÁFA.
- `npm test` clicks every scenario through and checks the exact total.
- **Per m³:** Budapest 9 900 Ft (min. 4 m³), Pest megye 10 900 Ft (min. 5 m³),
  környező megye 10 900 Ft (min. 8 m³). +10% per floor without a lift.
  Veszélyes hulladék 29 900 Ft/m³.
- **Volume** = floor area × fill: "normál" is half the m² (Róbert's rule); the
  other fill levels (0,15 / 0,75 / 1) are Milán's assumptions - check them.
- **A call instead of a price:** takarítás, illegális hulladék, over 100 m³,
  Távolabb.

## Run, test, deploy

```bash
npm install
npm start          # http://localhost:8893
npm test           # clicks through hundreds of random conversations + sample quotes
```

Locally, copy `.env.example` to `.env.local`. Without `RESEND_API_KEY` no e-mail
goes out; without an AI key typed messages fall back to the buttons.

## Deploy on Vercel

1. Vercel → **Add New… → Project** → import
   `Pirintvisuals/banacraft-ingatlankiurites-quoting-agent`.
2. **Framework Preset:** Other. Leave Root Directory, Build Command and Output
   Directory empty - there is no build; Vercel serves `public/` and turns
   `api/faq-agent.js` into the function.
3. **Environment Variables** (before the first deploy):

   | Name | Value |
   |---|---|
   | `AI_PROVIDER` | `gemini` or `openai` |
   | `GEMINI_API_KEY` or `OPENAI_API_KEY` | a key created just for Banacraft (not NM Bau's) |
   | `RESEND_API_KEY` | a Resend API key created just for Banacraft |
   | `LEAD_EMAIL_TO` | `info@banacraft.hu` |
   | `LEAD_EMAIL_FROM` | a sender on a **verified** Resend domain, e.g. `Banacraft <ajanlat@banacraft.hu>` once banacraft.hu is verified in Resend |
   | `ZOHO_FLOW_WEBHOOK_URL` | optional |
   | `OWNER_TEST_KEY` | optional - protects the self-test below |

   Without `LEAD_EMAIL_FROM` it falls back to Resend's test sender, which only
   delivers to the Resend account owner's own address - not to info@banacraft.hu.
4. **Deploy.** Then check:
   - `https://YOUR-PROJECT.vercel.app/` - the demo page with the widget
   - `https://YOUR-PROJECT.vercel.app/api/faq-agent?selftest=1` - sends a test
     e-mail and reports what Resend answered

Changing an environment variable later needs a redeploy to take effect.

## Embedding on the Banacraft site

```html
<script>
  window.BANACRAFT_CONFIG = {
    apiUrl: "https://YOUR-PROJECT.vercel.app/api/faq-agent",
    assetsUrl: "https://YOUR-PROJECT.vercel.app",
    launcher: false
  };
</script>
<script src="https://YOUR-PROJECT.vercel.app/widget.js" defer></script>
```

Every `data-quote-agent` button on the site (Kipróbálom, the floating "Azonnali
árbecslés") opens the chat - the widget catches those clicks before the site's
placeholder script, so nothing else needs to change on the site.

`launcher: false` hides the widget's own round button because the site already has
a floating one. That site button is hidden on phones (`sm:inline-flex`), so either
keep `launcher: false` and rely on the in-page buttons on mobile, or delete the
site's placeholder button and drop `launcher: false`.

## What Banacraft receives

- **Finished estimate:** "Árbecslés: név - munka, település" - contact details,
  customer type, every answer, the itemised price, exclusions, warnings (e.g.
  azbeszt), and the full chat. The phone number and the price are in the subject.
- **No price, a call promised:** "Hívást kér: név, telefon - munka, település" -
  the answers, why there was no price, and the reference figure where there is one.
- **Stopped halfway:** "Félbehagyott beszélgetés: …" - sent when the chat is
  closed, the page is left, or after 3 idle minutes (max 3 per conversation).
- **Zoho Flow:** same webhook contract as the NM Bau bot, set
  `ZOHO_FLOW_WEBHOOK_URL` to enable. `quote_basis` is `"floor"`, and
  low = high = total. The payload is logged as `[zoho payload]` with contact details
  masked.

## Editing

- **Prices:** `P` in `lib/flow.js`.
- **Questions, buttons, order:** `FIELDS` and `fieldOrder()` in `lib/flow.js`.
- **What the AI may say about Banacraft:** `KNOWLEDGE` in `lib/flow.js`.
- **Greeting, teaser texts:** `BOT` at the top of `public/widget.js`.
- **Colours:** the variables at the top of `public/style.css`.
