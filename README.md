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

| Munka | Kérdések |
|---|---|
| Lakás, ház, nyaraló, hagyaték, iroda, egyéb | alapterület → telítettség → emelet/lift → teherautó távolsága → külön kezelendő hulladék (több is) → bútorszétszerelés → takarítás utána → kezdés |
| Pince/padlás, garázs, raktár/csarnok | ugyanez emelet-kérdés nélkül |
| Telek, udvar | terület → mennyi lom → teherautó → külön kezelendő → kezdés |
| Illegálisan lerakott hulladék | mennyiség → mi van benne (több is) → hol van → megközelítés → kezdés |
| Takarítás | típus (nagytakarítás, felújítás/festés/építés utáni, iroda, üzem/csarnok, egyéb) → terület → szennyezettség → ablakok → belmagasság (csarnoknál) → kezdés |

Then one form: név, telefon, település, e-mail (optional), **magánszemély / cég /
intézmény / társasház**, preferred survey time (optional).

**Kezdés** is always Amint lehet / 30 / 60 / 90 napon belül. Typing a later start
("jövő tavasszal") is politely refused: Banacraft only takes jobs starting within
3 months.

## Pricing

- **A floor, never a range.** Band answers are priced at their lower edge, "Nem
  tudom" at a modest default, and the assumption is printed ("kb. 12 m³ lommal
  számol…"). The number can only go up at the survey.
- **VAT:** magánszemély and társasház see gross (ÁFA-val), cég and intézmény see
  net + 27% ÁFA. The flow itself prices net.
- **All rates live in `P` at the top of `lib/flow.js`.** They are
  market-calibrated starting points, **not Banacraft's own price list** - replace
  them with Banacraft's numbers as soon as they're known. `npm test` prints sample
  quotes, so a bad edit shows immediately.

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
   | `GEMINI_API_KEY` or `OPENAI_API_KEY` | the key for that provider |
   | `RESEND_API_KEY` | Resend key |
   | `LEAD_EMAIL_TO` | `info@banacraft.hu` |
   | `LEAD_EMAIL_FROM` | a sender on a **verified** Resend domain, e.g. `Banacraft <ajanlat@send.traumbad.hu>` |
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
  azbeszt), and the full chat. Reply goes straight to the customer if they gave an
  e-mail.
- **Stopped halfway:** "Félbehagyott beszélgetés: …" - sent when the chat is
  closed, the page is left, or after 3 idle minutes (max 3 per conversation).
- **Zoho Flow:** same webhook contract as the NM Bau bot, set
  `ZOHO_FLOW_WEBHOOK_URL` to enable. `quote_basis` is `"floor"`, and
  low = high = total. The payload is still logged with a `[TEMP zoho payload]` line
  (copied from NM Bau) - remove it once the mapping is verified.

## Editing

- **Prices:** `P` in `lib/flow.js`.
- **Questions, buttons, order:** `FIELDS` and `fieldOrder()` in `lib/flow.js`.
- **What the AI may say about Banacraft:** `KNOWLEDGE` in `lib/flow.js`.
- **Greeting, teaser texts:** `BOT` at the top of `public/widget.js`.
- **Colours:** the variables at the top of `public/style.css`.
