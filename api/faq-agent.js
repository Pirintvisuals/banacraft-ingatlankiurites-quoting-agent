// ============================================================================
//  BANACRAFT - árbecslő asszisztens (shared engine)
//
//  This exact file ships in all three Banacraft bots (kiürítés, bontás,
//  palatető). Everything trade-specific - the questions, their buttons, the
//  price model and the facts the AI may repeat - lives in lib/flow.js, so this
//  file never needs editing per trade.
//
//  Division of labour:
//   - The BACKEND owns the conversation. It decides which question comes next,
//     words it, renders its buttons and maps the answer onto a value. A clicked
//     button never costs a model call, so the bot answers instantly and cannot
//     drift out of step with its own buttons.
//   - The AI is called only when the customer types something the backend
//     cannot map: a question of their own, or an answer in their own words. It
//     replies in a fixed JSON shape - what to say, and which option the words
//     meant, if any - and the backend checks that option against the flow.
//   - The PRICE comes from lib/flow.js, deterministically: a starting price
//     (alapár "-tól") plus named exclusions, never a range. A range anchors the
//     customer to its low end and the owner has to argue upward at the survey;
//     a floor can only go up from a number that was presented as a minimum.
// ============================================================================
import { waitUntil } from "@vercel/functions";
import * as FLOW from "../lib/flow.js";

const PHONE = process.env.LEAD_PHONE || FLOW.BOT.phone;
const leadTo = () => process.env.LEAD_EMAIL_TO || FLOW.BOT.email;
const leadFrom = () => process.env.LEAD_EMAIL_FROM || "Banacraft <onboarding@resend.dev>";

// Flow prices are NET. Private customers and condominiums are shown the gross
// figure (what they will actually pay); companies and institutions reclaim VAT
// and think in net, so they get net + ÁFA.
const VAT_RATE = 0.27;

// ---------------------------------------------------------------------------
//  Formatting
// ---------------------------------------------------------------------------
function formatHuf(n) {
    return Math.round(n).toLocaleString("hu-HU").replace(/\s/g, " ") + " Ft";
}
const roundTo = (n, step) => Math.round(n / step) * step;
const oneLine = (s) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim();
const plain = (s) => String(s == null ? "" : s).replace(/\*\*/g, "");

// ===========================================================================
//  SECURITY HELPERS - this endpoint is public and spends real money (LLM API +
//  Resend e-mail), so abuse (cost-draining floods, spam relay, prompt/HTML
//  injection) has to be impractical. App-level controls; for go-live also
//  enable Vercel WAF rate limiting at the platform edge.
// ===========================================================================

// HTML-escape any user-controlled string before it goes into an e-mail body.
function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Hidden control blocks (<!--ANSWER:...-->) and bubble markers never belong in
// anything a person reads.
function stripControl(text) {
    return String(text || "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\[\[SPLIT\]\]/g, "\n\n")
        .trim();
}

// The chat history as HTML for the owner e-mail. Everything is escaped; a chip
// click is an ordinary user message, so a click-only conversation reads like a
// typed one.
function transcriptHtml(rows) {
    if (!Array.isArray(rows)) return "";
    return rows
        .filter((m) => m && typeof m.content === "string" && m.content.trim())
        .map((m) => {
            const who = (m.role === "assistant" || m.role === "model") ? "Asszisztens" : "Ügyfél";
            const clean = stripControl(m.content);
            if (!clean) return "";
            return `<p style="margin:0 0 10px"><b>${who}:</b><br>${esc(clean).replace(/\n/g, "<br>")}</p>`;
        })
        .join("");
}

// Same transcript as plain text, for the text/plain part of the owner e-mail.
function transcriptText(rows) {
    if (!Array.isArray(rows)) return "";
    return rows
        .filter((m) => m && typeof m.content === "string" && m.content.trim())
        .map((m) => {
            const who = (m.role === "assistant" || m.role === "model") ? "Asszisztens" : "Ügyfél";
            const clean = plain(stripControl(m.content));
            return clean ? `${who}:\n${clean}\n` : "";
        })
        .filter(Boolean)
        .join("\n");
}

// How many messages the customer actually sent (clicks included).
function customerTurns(rows) {
    if (!Array.isArray(rows)) return 0;
    return rows.filter((m) => m && m.role === "user" && typeof m.content === "string" && m.content.trim()).length;
}

// Best-effort client IP from the proxy headers Vercel sets.
function clientIp(req) {
    const xf = req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"]);
    if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim();
    return (req.socket && req.socket.remoteAddress) || "unknown";
}

// In-memory fixed-window rate limiter. Per-instance only (Vercel may run
// several), so it is a best-effort first line, not a hard guarantee.
const RL_BUCKETS = new Map();
function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    let b = RL_BUCKETS.get(key);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + windowMs }; RL_BUCKETS.set(key, b); }
    b.count++;
    if (RL_BUCKETS.size > 10000) {
        for (const [k, v] of RL_BUCKETS) if (now > v.resetAt) RL_BUCKETS.delete(k);
    }
    return b.count <= limit ? { ok: true } : { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
}
const RL_CHAT = { limit: Number(process.env.RL_CHAT_PER_MIN) || 40, windowMs: 60_000 };
const RL_TRANSCRIPT = { limit: Number(process.env.RL_TRANSCRIPT_PER_HOUR) || 20, windowMs: 60 * 60_000 };
const RL_SELFTEST = { limit: Number(process.env.RL_SELFTEST_PER_HOUR) || 6, windowMs: 60 * 60_000 };

// Payload shape/size caps - reject oversized or malformed bodies before a model
// call, and strip client-injected system turns.
const MAX_QUESTION_LEN = 2000;
const MAX_HISTORY_MSGS = 80;
const MAX_MSG_LEN = 8000;
const ALLOWED_ROLES = new Set(["user", "assistant", "model"]); // NB: no "system"
function validateChatInput(question, history) {
    if (question != null && (typeof question !== "string" || question.length > MAX_QUESTION_LEN)) return "A kérdés túl hosszú.";
    if (history != null) {
        if (!Array.isArray(history) || history.length > MAX_HISTORY_MSGS) return "Érvénytelen előzmény.";
        for (const m of history) {
            if (!m || typeof m !== "object") return "Érvénytelen előzmény.";
            if (typeof m.content !== "string" || m.content.length > MAX_MSG_LEN) return "Érvénytelen előzmény.";
            if (!ALLOWED_ROLES.has(m.role)) return "Érvénytelen előzmény.";
        }
    }
    return null;
}

// The widget embeds on the Banacraft sites, so any origin is allowed by default
// (no credentials are involved). Set ALLOWED_ORIGINS to lock it down.
function applyCors(req, res) {
    const allow = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = (req.headers && req.headers.origin) || "";
    let value = "*";
    if (allow.length) value = allow.includes(origin) ? origin : allow[0];
    res.setHeader("Access-Control-Allow-Origin", value);
    if (allow.length) res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
}

// ---------------------------------------------------------------------------
//  Contact detail checks
// ---------------------------------------------------------------------------
const GMAIL_TYPOS = new Set([
    "gmial.com", "gmai.com", "gmal.com", "gmil.com", "gmali.com", "gamil.com",
    "gmaill.com", "gmaul.com", "gmsil.com", "gmaik.com", "gmqil.com", "gnail.com",
    "gmile.com", "gmaol.com", "gmail.con", "gmail.co", "gmail.cm", "gmail.om",
    "gmail.comm", "gmail.cpm", "gmail.vom", "gmail.xom", "gmail.ocm", "gmail.cim",
    "gmail.coom", "gmaill.con", "freemail.h", "freemial.hu", "fremail.hu",
]);
// "format" | "gmail" | null. Only clear typos are flagged; an unfamiliar but
// valid domain (a company address) is never rejected.
function emailIssue(email) {
    const e = String(email || "").trim().toLowerCase();
    const m = e.match(/^[^\s@]+@([^\s@]+\.[^\s@]+)$/);
    if (!m) return "format";
    const domain = m[1];
    if (domain === "gmail.com") return null;
    if (domain.startsWith("gmail.")) return "gmail";
    if (GMAIL_TYPOS.has(domain)) return "gmail";
    return null;
}

// A Hungarian number is 9 significant digits (+36 / 06 prefix optional).
// A local landline without its prefix ("1 234 5678") is 8; a number made of one
// or two digits repeated is someone dodging the form, not a lead.
function phoneIssue(phone) {
    const d = String(phone || "").replace(/[^\d]/g, "");
    if (d.length < 8 || d.length > 13) return "format";
    return new Set(d).size >= 3 ? null : "format";
}

// Any settlement, district or postcode is fine; reject only an empty answer and
// a phone number that bled into the field.
function locationIssue(loc) {
    const s = String(loc || "").trim();
    if (s.length < 2 || s.length > 80) return "format";
    const digits = s.replace(/\D/g, "");
    const letters = s.replace(/[^\p{L}]/gu, "");
    if (!letters) return /^\d{4}$/.test(digits) ? null : "format";
    if (digits.length > 6 && letters.length < 2) return "format";
    return null;
}

// ===========================================================================
//  FLOW MACHINERY - generic over whatever lib/flow.js defines
// ===========================================================================
const has = (s, k) => !!s && s[k] != null && String(s[k]).trim() !== "";
const fieldDef = (field) => (field && FLOW.FIELDS[field]) || null;
const textOf = (v, sel) => (typeof v === "function" ? v(sel || {}) : v);

function optionsFor(field, sel) {
    const f = fieldDef(field);
    if (!f) return [];
    return (typeof f.options === "function" ? f.options(sel || {}) : f.options) || [];
}

// Every value a field can ever hold, whatever the other answers are. Fields with
// answer-dependent options list them in `values`.
function allValues(field) {
    const f = fieldDef(field);
    if (!f) return [];
    if (Array.isArray(f.values)) return f.values;
    return Array.isArray(f.options) ? f.options.map((o) => o.value) : [];
}

// The project questions that apply to this conversation, in order. The flow can
// add or skip questions depending on earlier answers.
function projectOrder(sel) {
    return FLOW.fieldOrder(sel || {}).filter((f) => fieldDef(f));
}
function pendingField(sel) {
    for (const f of projectOrder(sel)) if (!has(sel, f)) return f;
    return null;
}
function progressOf(sel) {
    const order = projectOrder(sel);
    return { progress: order.filter((f) => has(sel, f)).length, progressTotal: order.length };
}

function norm(s) {
    return String(s || "").normalize("NFC").toLowerCase()
        .replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

// A typed area: "65", "kb. 65 nm", "65 m²-es", "1 200 m2". Only when the message
// is just the number and its unit - anything else after the number ("2 szobás",
// "3 emelet") is not an area and goes to the model.
function parseArea(text) {
    const m = String(text || "").toLowerCase().trim()
        .replace(/(\d)[\s.](\d{3})(?!\d)/g, "$1$2")
        .replace(",", ".")
        .match(/^(?:kb\.?|körülbelül|korulbelul|nagyjából|nagyjabol|kábé|kabe|cirka|~)?\s*(\d{1,6}(?:\.\d+)?)\s*(?:m2|m²|nm|négyzetméter\p{L}*|negyzetmeter\p{L}*|m)?(?:-?[eéö]s)?\s*(?:kb\.?|körülbelül|korulbelul|nagyjából|nagyjabol|lehet|talán|talan)?[.!]?$/u);
    if (!m) return null;
    const n = Math.round(parseFloat(m[1]) * 10) / 10;
    return n >= 1 && n <= 100000 ? n : null;
}

// Typed answers that are a button in other words: no accents, a trailing full
// stop, or the start of exactly one label ("igen" for "Igen, le vannak kötve").
// Ambiguous or longer text is left to the model.
const fold = (s) => norm(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.!]+$/, "");
function looseOption(opts, text) {
    const t = fold(text);
    if (t.length < 2) return null;
    const same = opts.find((o) => fold(o.label) === t);
    if (same) return same;
    const hits = opts.filter((o) => {
        const l = fold(o.label);
        return l.startsWith(t) && /^[\s,(]/.test(l.slice(t.length));
    });
    return hits.length === 1 ? hits[0] : null;
}

// Several picks of a multi-select are stored comma-joined. A "none of these"
// option is meaningless next to a real pick, so it drops out.
function joinMulti(field, vals) {
    const f = fieldDef(field);
    let v = [...new Set(vals)];
    const none = f.none || [];
    if (v.length > 1) v = v.filter((x) => !none.includes(x));
    return v.length ? v.join(",") : null;
}

// Map the customer's message onto the field being asked, WITHOUT the model.
// Choice: the clicked chip label. Multi: chip labels joined with " · " (that is
// what the widget sends). Area: a chip, or a bare number.
const MULTI_SEP = "·";
function mapAnswer(field, text, sel) {
    const f = fieldDef(field);
    const a = norm(text);
    if (!f || !a) return null;
    const opts = optionsFor(field, sel);
    const byLabel = (s) => opts.find((o) => norm(o.label) === s);
    if (f.type === "multi") {
        const vals = [];
        for (const p of a.split(MULTI_SEP).map((x) => x.trim()).filter(Boolean)) {
            const o = byLabel(p) || looseOption(opts, p);
            if (!o) return null;
            vals.push(o.value);
        }
        return joinMulti(field, vals);
    }
    const o = byLabel(a);
    if (o) return o.value;
    if (f.type === "area") {
        const n = parseArea(text);
        if (n != null) return String(n);
    }
    const loose = looseOption(opts, a);
    return loose ? loose.value : null;
}

// The widget carries the state between turns. Nothing in it is trusted: every
// value is checked against the flow's own option lists, and the quote is always
// recomputed here from the checked values.
const CONTACT_KEYS = ["name", "phone", "postal_code", "email", "customer_type", "survey_time"];
function sanitizeState(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const field of Object.keys(FLOW.FIELDS)) {
        if (!has(raw, field)) continue;
        const f = FLOW.FIELDS[field];
        const v = String(raw[field]).slice(0, 400);
        const allowed = new Set(allValues(field));
        if (f.type === "multi") {
            const vals = v.split(",").filter((x) => allowed.has(x));
            if (vals.length) out[field] = [...new Set(vals)].join(",");
        } else if (allowed.has(v)) {
            out[field] = v;
        } else if (f.type === "area" && parseArea(v) != null) {
            out[field] = String(parseArea(v));
        }
    }
    for (const k of CONTACT_KEYS) if (has(raw, k)) out[k] = oneLine(raw[k]).slice(0, 200);
    if (out.customer_type && !CUSTOMER_TYPES.some((c) => c.value === out.customer_type)) delete out.customer_type;
    if (out.survey_time && !SURVEY_TIMES.includes(out.survey_time)) delete out.survey_time;
    return out;
}

// Human-readable value of an answer, for bubbles, e-mails and the CRM.
function labelFor(field, value, sel) {
    const f = fieldDef(field);
    if (!f || value == null || String(value) === "") return "-";
    const opts = optionsFor(field, sel);
    const find = (v) => opts.find((o) => o.value === v);
    if (f.type === "multi") return String(value).split(",").map((v) => (find(v) || {}).label || v).join(", ");
    const o = find(String(value));
    if (o) return o.label;
    if (f.type === "area") return `${String(value).replace(".", ",")} m²`;
    return String(value);
}

function summaryPairs(sel) {
    return projectOrder(sel)
        .filter((f) => has(sel, f))
        .map((f) => [textOf(fieldDef(f).short, sel) || f, labelFor(f, sel[f], sel)]);
}

function questionText(field, sel) {
    const f = fieldDef(field);
    const lines = [`**${textOf(f.q, sel)}**`];
    const hint = textOf(f.hint, sel);
    if (hint) lines.push(hint);
    if (f.type === "multi") lines.push("Több is választható - a végén nyomja meg a **Tovább** gombot.");
    return lines.join("\n");
}

// Short confirmation of the answer just recorded, plus the flow's own note on
// it where there is one (e.g. "that needs a structural engineer").
const ACK = ["Rendben", "Értem", "Köszönöm", "Rögzítettem"];
function ackText(field, sel) {
    const f = fieldDef(field);
    const i = Math.max(0, projectOrder(sel).indexOf(field)) % ACK.length;
    const note = textOf(f.after, sel);
    return `${ACK[i]}: **${labelFor(field, sel[field], sel)}**.` + (note ? `\n${note}` : "");
}

// Customers who want to start later than 90 days are not Banacraft's customers
// (their call). Caught before any model call, on the timeline question only.
// Seasons and "jövőre" depend on today: "télen" in late October is five weeks
// away, not a refusal. Those near enough go to the model, which knows the date.
const TOO_LATE_ALWAYS = /(fél\s*év\s*múlva|fél\s*évre|év\s*múlva|(?<![\p{L}\d])([4-9]|1[0-2])\s*hónap|(?<![\p{L}\d])(négy|öt|hat|hét|nyolc|kilenc|tíz|tizenegy|tizenkét)\s*hónap)/iu;
const NEXT_YEAR = /(jövőre|(jövő|következő)\s*év)/iu;
const SEASONS = [[/(?<!\p{L})tavas/iu, 2], [/(?<!\p{L})nyár/iu, 5], [/(?<!\p{L})ős[sz]/iu, 8], [/(?<!\p{L})tél/iu, 11]];
const DAY_MS = 24 * 60 * 60 * 1000;
function tooLate(text, now = new Date()) {
    const s = String(text || "");
    if (TOO_LATE_ALWAYS.test(s)) return true;
    const y = now.getFullYear(), m = now.getMonth();
    if (NEXT_YEAR.test(s)) return (new Date(y + 1, 0, 1) - now) / DAY_MS > 90;
    const season = SEASONS.find(([re]) => re.test(s));
    if (!season) return false;
    const start = season[1];
    // Already in that season (winter runs over New Year).
    if (start === 11 ? (m === 11 || m < 2) : (m >= start && m < start + 3)) return false;
    const next = new Date(m < start ? y : y + 1, start, 1);
    return (next - now) / DAY_MS > 90;
}
const TIMELINE_LIMIT = () =>
    `Köszönöm, hogy jelezte! Jelenleg a **legfeljebb 3 hónapon (90 napon) belül** induló munkákat tudjuk vállalni. ` +
    `Ha a munka ezen belül el tud indulni, válassza ki, mikorra. Ha később lesz aktuális, keressen minket bátran akkor: **${PHONE}**.`;

// ---------------------------------------------------------------------------
//  Contact form - once every project question is answered, the rest is admin,
//  so it is one form instead of four more bubbles.
// ---------------------------------------------------------------------------
const FORM = "__contact";
const SURVEY = "__survey"; // the survey-time buttons offered under a finished quote
const CUSTOMER_TYPES = [
    { label: "Magánszemély", value: "magan" },
    { label: "Cég", value: "ceg" },
    { label: "Intézmény", value: "intezmeny" },
    { label: "Társasház", value: "tarsashaz" },
];
const SURVEY_TIMES = ["Hétköznap délelőtt", "Hétköznap délután", "Szombaton", "Mindegy, hívjanak először"];
const REQUIRED_CONTACT = ["name", "phone", "postal_code", "customer_type"];
const contactReady = (s) => REQUIRED_CONTACT.every((k) => has(s, k));
const FORM_INTRO = "Köszönöm, megvan minden a számításhoz! Már csak az elérhetősége kell, és rögtön mutatom az **alapárat**.";

function contactForm(sel) {
    const val = (k) => (has(sel, k) ? String(sel[k]) : "");
    const ct = CUSTOMER_TYPES.find((c) => c.value === sel.customer_type);
    return {
        title: "Utolsó lépés: kinek készül az árbecslés?",
        why: "Az adatait csak az árbecslés és a helyszíni felmérés egyeztetéséhez használjuk. A kérés nem kötelez semmire.",
        submit: "Kérem az alapárat",
        fields: [
            { key: "name", label: "Név", placeholder: "Az Ön neve", type: "text", autocomplete: "name", value: val("name") },
            { key: "phone", label: "Telefonszám", placeholder: "+36 30 123 4567", type: "tel", autocomplete: "tel", value: val("phone") },
            { key: "postal_code", label: "Település", placeholder: "pl. Budapest XI. vagy Érd", type: "text", autocomplete: "address-level2", value: val("postal_code") },
            { key: "customer_type", label: "Kinek a nevében kéri?", type: "select", options: CUSTOMER_TYPES.map((c) => c.label), value: ct ? ct.label : CUSTOMER_TYPES[0].label },
        ],
    };
}

// The "call me instead" shortcut: just enough to ring them back.
function validateCallback(contact) {
    const c = contact && typeof contact === "object" ? contact : {};
    const name = oneLine(c.name).slice(0, 200);
    const phone = oneLine(c.phone).slice(0, 200);
    const errors = {};
    if (name.length < 2) errors.name = "Kérem, adja meg a nevét.";
    if (!phone) errors.phone = "Kérem, töltse ki.";
    else if (phoneIssue(phone)) errors.phone = "Ezt a számot nem sikerült értelmezni (pl. +36 30 123 4567).";
    return Object.keys(errors).length ? { errors } : { values: { name, phone } };
}

// Validate a whole submitted form at once; errors are keyed by field so the
// widget can mark the offending input.
function validateContactForm(contact) {
    const c = contact && typeof contact === "object" ? contact : {};
    const get = (k) => oneLine(c[k]).slice(0, 200);
    const errors = {};
    const values = {};
    const REQ = "Kérem, töltse ki.";

    const name = get("name");
    if (!name) errors.name = REQ;
    else if (name.length < 2) errors.name = "Kérem, adja meg a teljes nevét.";
    else values.name = name;

    const phone = get("phone");
    if (!phone) errors.phone = REQ;
    else if (phoneIssue(phone)) errors.phone = "Ezt a számot nem sikerült értelmezni (pl. +36 30 123 4567).";
    else values.phone = phone;

    const place = get("postal_code");
    if (!place) errors.postal_code = REQ;
    else if (locationIssue(place)) errors.postal_code = "Kérem, a település nevét vagy az irányítószámot adja meg.";
    else values.postal_code = place;

    const email = get("email");
    if (email) {
        const i = emailIssue(email);
        if (i === "gmail") errors.email = "Elírás lehet a címben - a Gmail végződése gmail.com.";
        else if (i) errors.email = "Ezt az e-mail címet nem sikerült értelmezni.";
        else values.email = email;
    }

    const ctRaw = get("customer_type");
    const ct = CUSTOMER_TYPES.find((t) => norm(t.label) === norm(ctRaw) || t.value === ctRaw);
    if (!ct) errors.customer_type = "Kérem, válasszon.";
    else values.customer_type = ct.value;

    const st = SURVEY_TIMES.find((t) => norm(t) === norm(get("survey_time")));
    if (st) values.survey_time = st;

    return Object.keys(errors).length ? { errors } : { values };
}

// ---------------------------------------------------------------------------
//  Quote - the flow prices the job in net Ft; this puts it on the customer's
//  VAT basis and rounds it for display.
// ---------------------------------------------------------------------------
function vatBasis(sel) {
    return sel.customer_type === "ceg" || sel.customer_type === "intezmeny" ? "net" : "gross";
}

function assembleQuote(sel) {
    const basis = vatBasis(sel);
    const k = basis === "gross" ? 1 + VAT_RATE : 1;
    // Amounts the flow quotes inside sentences (unit rates in the exclusions) go
    // through the same VAT basis and the same rounding as the line items, so a
    // fridge is not 11 000 Ft in the list and "további darabonként 11 400 Ft"
    // two lines below. Small per-m² rates keep their hundreds.
    const money = (n) => {
        const v = n * k;
        return formatHuf(roundTo(v, v >= 10000 ? 1000 : 100));
    };
    const raw = FLOW.buildQuote(sel, { money });
    const items = raw.items
        .filter((i) => i.amount > 0)
        .map((i) => ({ label: i.label, amount: roundTo(i.amount * k, 1000) }));
    const total = items.reduce((s, i) => s + i.amount, 0);
    const netTotal = roundTo(raw.items.reduce((s, i) => s + Math.max(0, i.amount), 0), 1000);
    return {
        title: raw.title,
        includes: raw.includes,
        exclusions: raw.exclusions || [],
        flags: raw.flags || [],
        items, total, netTotal, basis,
    };
}

function vatNote(q) {
    return q.basis === "gross" ? "bruttó ár, az ÁFA-t tartalmazza" : "nettó ár, + 27% ÁFA";
}

// Customer-facing result, as three bubbles split by [[SPLIT]].
function renderCustomerQuote(q, sel) {
    const priceBubble = [
        `Köszönöm, ${oneLine(sel.name)}! Elkészült az **előzetes árbecslés**.`,
        ``,
        `**Alapár: ${formatHuf(q.total)}-tól**`,
        `(${vatNote(q)})`,
        ``,
        `**${q.title}**`,
        ...q.items.map((i) => `• ${i.label} - **${formatHuf(i.amount)}**`),
    ].join("\n");

    const scope = [`**Mit tartalmaz?**`, `Az alapár ${q.includes}.`, ``, `**Ami az alapáron felül jöhet:**`, ...q.exclusions.map((e) => `• ${e}`)];
    if (q.flags.length) scope.push(``, ...q.flags.map((f) => `**Fontos:** ${f}`));

    const next = [
        `**Hogyan tovább?**`,
        `• Kollégánk **hamarosan hívja** a megadott számon.`,
        `• Egyeztetünk egy **ingyenes helyszíni felmérést**.`,
        `• A felmérés után **írásos, végleges árajánlatot** kap.`,
        ``,
        `**Mikor lenne jó Önnek a felmérés?**`,
        `Ha kérdése van, írja meg itt nyugodtan.`,
    ].join("\n");

    return [priceBubble, scope.join("\n"), next].join("\n[[SPLIT]]\n");
}

// ===========================================================================
//  AI - only for messages the backend cannot map
// ===========================================================================
function systemPrompt() {
    return `SZEMÉLYISÉG
Te a Banacraft weboldalán működő árbecslő asszisztens vagy (${FLOW.BOT.service}). A cég nevében beszélsz, magázódva, kizárólag MAGYARUL. Kedves, közvetlen, tömör és szakértő vagy - ne legyél tolakodó.

A CÉGRŐL - kizárólag ezekre a tényekre támaszkodj
${FLOW.KNOWLEDGE}
- Telefon: ${PHONE} · E-mail: ${FLOW.BOT.email}
- A Banacraft mindhárom szolgáltatást végzi: ingatlankiürítés, lomtalanítás és takarítás · belső bontás és épületbontás · azbeszt palatető bontása, elszállítása és új tetőfedés. Ha az ügyfél a másik kettő közül említ valamit, mondd el röviden, hogy abban is szívesen segítünk, és a részleteket kollégánk egyezteti.

SZABÁLYOK
- Legfeljebb 3 hónapon (90 napon) belül induló munkákat vállalunk. Ha valaki ennél később kezdené, mondd el ezt udvariasan.
- Soha ne mondj, ne becsülj és ne számolj árat. Az alapárat a rendszer számolja ki a kérdések végén; ha árat kérdeznek, mondd, hogy néhány kérdés után azonnal megjelenik.
- Ne ígérj konkrét időpontot, kedvezményt, és semmit, ami nincs a fenti tények között. Ha nem tudod a választ, mondd, hogy ezt kollégánk a felmérésen vagy telefonon pontosítja.
- Soha ne javasold, hogy az ügyfél maga bontson, vágjon vagy mozgasson azbeszttartalmú anyagot.
- Legfeljebb 60 szó. A kulcsszavakat **félkövérrel** emeld ki; felsorolásnál a sor "• " jellel kezdődjön.
- Soha ne használj emojit és hosszú gondolatjelet; helyette sima kötőjelet írj.
- A válaszgombokat a rendszer jeleníti meg, neked nem kell kiírnod őket.`;
}

// The model answers in a fixed JSON shape: what to say, and - when the words
// were an answer - which option they meant. A hidden tag at the end of free
// text was tried first and proved unreliable: the model would confirm an answer
// in its reply ("tehát 30 napon belül") and still leave the tag out, so the
// answer never got recorded and the bot sat on the same question.
function directive(field, sel, mode) {
    const known = summaryPairs(sel).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "- még semmi";
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Budapest" });
    const head = `\n\nA mai dátum: ${today}. Ha az ügyfél kezdési időpontot mond, ehhez mérd; ha 90 napnál későbbi, az "ertek" null, és mondd el a 90 napos szabályt.\n\n=== AMIT EDDIG TUDUNK ===\n${known}\n`;
    const format = `

=== A VÁLASZ FORMÁTUMA ===
Kizárólag egyetlen JSON objektumot írj, semmi mást: {"valasz": "<az ügyfélnek szóló üzenet>", "ertek": <lásd lent>}
A "valasz" szövegében használhatsz **félkövért** és "• " kezdetű felsorolást, de a választási lehetőségeket SOHA ne sorold fel - a gombokat a rendszer mutatja.`;
    if (mode === "form" || mode === "done") {
        const situation = mode === "form"
            ? "Az ügyfél minden kérdésre válaszolt; a képernyőn egy rövid űrlap vár a nevére, telefonszámára és településére. Válaszolj röviden az üzenetére, majd kérd meg, hogy töltse ki az űrlapot - utána azonnal látja az alapárat."
            : "Az árbecslés már elkészült, az ügyfél látta. Válaszolj röviden a kérdésére. Új árat ne adj; ha a munka részletein változtatna, mondd, hogy ezt kollégánk a felmérésen pontosítja.";
        return head + `\n=== HELYZET ===\n${situation}` + format + `\nAz "ertek" mindig null.`;
    }
    const f = fieldDef(field);
    const options = optionsFor(field, sel);
    const multi = f.type === "multi";
    const area = f.type === "area";
    const example = multi
        ? `a választott értékek tömbje, pl. ["${options.slice(0, 2).map((o) => o.value).join('", "')}"]`
        : area
            ? `a választott érték, vagy a négyzetméter számként, pl. 65`
            : `a választott érték, pl. "${options[0] ? options[0].value : ""}"`;
    return head + `
=== A JELENLEGI KÉRDÉS (a rendszer határozza meg) ===
"${textOf(f.q, sel)}"
A lehetséges értékek (érték: felirat):
${options.map((o) => `- ${o.value}: ${o.label}`).join("\n")}
${multi ? "Ennél a kérdésnél TÖBB érték is választható.\n" : ""}${area ? "Konkrét négyzetméter is megadható.\n" : ""}` + format + `

MIT TEGYÉL
1. Ha az ügyfél üzenete EGYÉRTELMŰEN megválaszolja ezt a kérdést, akár a saját szavaival (pl. "két héten belül" = 30 napon belül, "nincs lift, harmadik emelet" = 1–3. emelet, lift nélkül): "valasz" = egyetlen rövid visszaigazoló mondat, és a következő kérdést NE tedd fel, azt a rendszer teszi fel; "ertek" = ${example}.
2. Ha az ügyfél kérdezett valamit, vagy a válasza nem egyértelmű: "valasz" = rövid válasz, majd kérd meg, hogy válasszon a lenti gombok közül, és a kérdést ismételd meg **félkövérrel**; "ertek" = null.
3. Ha az üzenet kérdés ÉS egyértelmű válasz is: válaszolj a kérdésre, és add meg az "ertek"-et is.
4. Csak a fenti listában szereplő értéket használj, és soha ne tegyél fel ettől eltérő kérdést.`;
}

// A provider that hangs must not hold the customer's reply: past this the other
// provider is tried, then the buttons come back.
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 8000;

async function callOpenAI(messages) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { ok: false, error: "Missing OPENAI_API_KEY" };
    try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(AI_TIMEOUT_MS),
            body: JSON.stringify({
                model: process.env.OPENAI_MODEL || "gpt-4o-mini",
                messages,
                temperature: 0.2,
                max_tokens: 400,
                response_format: { type: "json_object" },
            }),
        });
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content;
        if (text) return { ok: true, text };
        return { ok: false, error: data.error?.message || JSON.stringify(data) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function callGemini(messages) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { ok: false, error: "Missing GEMINI_API_KEY" };
    const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
    const systemMsg = messages.find((m) => m.role === "system");
    const contents = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const request = (thinkingConfig) => fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            signal: AbortSignal.timeout(AI_TIMEOUT_MS),
            body: JSON.stringify({
                system_instruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
                contents,
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 1500,
                    responseMimeType: "application/json",
                    ...(thinkingConfig ? { thinkingConfig } : {}),
                },
            }),
        }
    );
    try {
        // Thinking settings differ by model generation. A model that rejects
        // them still answers without them.
        let res = await request(/^gemini-2/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" });
        if (res.status === 400) res = await request(null);
        const data = await res.json();
        const cand = data.candidates?.[0];
        const text = (cand?.content?.parts || []).map((p) => p?.text || "").join("");
        if (text) return { ok: true, text };
        return { ok: false, error: data.error?.message || JSON.stringify(data) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function askModel(sel, history, text, field, mode) {
    const messages = [{ role: "system", content: systemPrompt() + directive(field, sel, mode) }];
    const past = (Array.isArray(history) ? history : []).slice(-16);
    for (const m of past) {
        if (!m || typeof m.content !== "string" || !m.content.trim()) continue;
        messages.push({ role: m.role === "user" ? "user" : "assistant", content: stripControl(m.content) });
    }
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user" || last.content.trim() !== text) messages.push({ role: "user", content: text });
    const provider = (process.env.AI_PROVIDER || "openai").toLowerCase() === "gemini" ? "gemini" : "openai";
    const callers = { openai: callOpenAI, gemini: callGemini };
    let result = await callers[provider](messages);
    if (!result.ok) {
        console.error(`[${provider}] AI hiba:`, result.error);
        // A retired model or an outage on one provider should not cost a lead
        // when a key for the other one is set.
        const other = provider === "gemini" ? "openai" : "gemini";
        if (process.env[`${other.toUpperCase()}_API_KEY`]) {
            result = await callers[other](messages);
            if (!result.ok) console.error(`[${other}] AI hiba:`, result.error);
        }
    }
    return result;
}

// The price only ever comes from lib/flow.js. The prompt forbids the model from
// naming one, and this catches the time it does anyway.
const PRICE_TALK = /\d[\d\s.,]*\s*(ft\b|forint|huf\b|ezer\b|millió)/i;
function withoutPrice(said, mode) {
    if (!PRICE_TALK.test(said)) return said;
    return mode === "done"
        ? "Az árbecslést fent látja. A végleges árat az ingyenes helyszíni felmérés után adjuk."
        : "Az alapárat a kérdések végén a rendszer számolja ki, utána azonnal látja.";
}

// Read the model's reply: the JSON contract first; if a provider ignored JSON
// mode, a legacy <!--ANSWER:...--> tag; otherwise the text as it is.
function interpretModel(text, field, sel) {
    const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let said = raw;
    let value = null;
    try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === "object") {
            said = obj.valasz != null ? String(obj.valasz) : "";
            value = obj.ertek != null ? obj.ertek : null;
        }
    } catch (e) {
        const m = raw.match(/<!--\s*ANSWER:\s*([\s\S]*?)-->/);
        if (m) value = m[1];
    }
    return { said: cleanModelText(said), value: field && value != null ? acceptModelValue(field, value, sel) : null };
}

// What the model says the customer meant, checked against this field's own
// options. It may name the value or echo the button label, as a string or (for
// multi-selects) an array; anything that is not a real option is dropped.
function acceptModelValue(field, raw, sel) {
    const f = fieldDef(field);
    if (!f) return null;
    const opts = optionsFor(field, sel);
    const one = (x) => {
        const s = String(x == null ? "" : x).trim();
        if (!s) return null;
        const o = opts.find((o) => o.value === s || norm(o.label) === norm(s));
        return o ? o.value : null;
    };
    if (f.type === "multi") {
        const parts = Array.isArray(raw) ? raw : String(raw).split(",");
        const vals = parts.map(one).filter(Boolean);
        return vals.length ? joinMulti(field, vals) : null;
    }
    const v = one(Array.isArray(raw) ? raw[0] : raw);
    if (v) return v;
    if (f.type === "area") {
        const n = typeof raw === "number" ? raw : parseArea(String(raw));
        if (n != null && n >= 1 && n <= 100000) return String(n);
    }
    return null;
}

function cleanModelText(text) {
    return String(text || "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/—/g, "-")
        .replace(/^[ \t]*[*-][ \t]+/gm, "• ") // markdown bullets -> the widget's bullet
        .trim();
}

// ===========================================================================
//  Handler
// ===========================================================================
function send(response, sel, answer, key, extra = {}) {
    const out = { answer, state: sel, chips: [], field: key || null, ...progressOf(sel), ...extra };
    if (key === FORM) {
        out.form = contactForm(sel);
    } else if (key === SURVEY) {
        out.chips = SURVEY_TIMES;
    } else if (key) {
        const f = fieldDef(key);
        const opts = optionsFor(key, sel);
        out.chips = opts.map((o) => o.label);
        if (f.type === "multi") {
            out.multi = true;
            out.exclusive = opts.filter((o) => (f.none || []).includes(o.value)).map((o) => o.label);
            out.next = "Tovább";
        }
    }
    return response.status(200).json(out);
}

// What to ask once `sel` has just gained an answer: the next question, or the
// contact form when the project questions are done.
function nextStep(sel) {
    const next = pendingField(sel);
    if (next) return { text: questionText(next, sel), key: next };
    return { text: FORM_INTRO, key: FORM };
}

export default async function handler(request, response) {
    applyCors(request, response);
    if (request.method === "OPTIONS") return response.status(204).end();

    // The transcript beacon arrives as text/plain (so it survives the page
    // closing without a CORS preflight), i.e. as a raw string body.
    if (typeof request.body === "string") {
        try { request.body = JSON.parse(request.body); } catch (e) { request.body = {}; }
    }
    const ip = clientIp(request);

    if (request.method === "GET" && request.query && request.query.selftest != null) {
        return await runSelfTest(request, response, ip);
    }
    if (request.method !== "POST") return response.status(405).json({ answer: "Method Not Allowed" });

    try {
        const body = request.body || {};
        const { action, question, history } = body;

        // --- The conversation ended without a finished quote: send the owner
        // everything that was said, so drop-offs are not invisible. ---
        if (action === "transcript") {
            const rl = rateLimit(`transcript:${ip}`, RL_TRANSCRIPT.limit, RL_TRANSCRIPT.windowMs);
            if (!rl.ok) return response.status(429).json({ ok: false, error: "rate_limited" });
            if (validateChatInput(null, history)) return response.status(400).json({ ok: false, error: "invalid_history" });
            if (customerTurns(history) < 1) return response.status(200).json({ ok: false, skipped: "no_answers" });
            const sent = await sendTranscriptEmail(sanitizeState(body.state), history, {
                sessionId: body.sessionId, pageUrl: body.pageUrl, reason: body.reason, update: !!body.update,
            });
            return response.status(200).json({ ok: !!sent.ok });
        }

        const rlChat = rateLimit(`chat:${ip}`, RL_CHAT.limit, RL_CHAT.windowMs);
        if (!rlChat.ok) {
            response.setHeader("Retry-After", String(rlChat.retryAfter));
            return response.status(429).json({ answer: "Túl sok üzenet rövid idő alatt. Kérjük, várjon egy kicsit." });
        }
        const bad = validateChatInput(question, history);
        if (bad) return response.status(400).json({ answer: bad });

        let sel = sanitizeState(body.state);

        // --- Opening: the first question, no model call. ---
        if (action === "start") {
            const step = nextStep(sel);
            return send(response, sel, step.text, step.key);
        }

        // --- "Call me instead": a lead from someone who will not finish the
        // questions. The answers so far go with it, and they can still carry on. ---
        if (action === "callback") {
            const res = validateCallback(body.contact);
            if (res.errors) return response.status(200).json({ answer: "", chips: [], state: sel, ...progressOf(sel), formErrors: res.errors });
            const sent = await sendTranscriptEmail({ ...sel, ...res.values }, history, {
                callback: true, sessionId: body.sessionId, pageUrl: body.pageUrl,
            });
            if (!sent.ok) {
                return response.status(200).json({
                    answer: `Elnézést, ezt most nem sikerült rögzítenünk. Kérjük, hívjon minket: **${PHONE}**.`,
                    chips: [], state: sel, ...progressOf(sel), callbackFailed: true,
                });
            }
            sel = { ...sel, ...res.values };
            const step = nextStep(sel);
            return send(response, sel,
                `Köszönöm, ${oneLine(sel.name)}! Kollégánk **hamarosan hívja** ezen a számon: ${oneLine(sel.phone)}.\n\nHa közben kíváncsi az alapárra, folytathatjuk:\n\n${step.text}`,
                step.key, { callbackDone: true });
        }

        // --- Contact form submitted. ---
        if (body.contact) {
            const pending = pendingField(sel);
            if (pending) return send(response, sel, questionText(pending, sel), pending);
            const res = validateContactForm(body.contact);
            if (res.errors) {
                return response.status(200).json({
                    answer: "", chips: [], state: sel, ...progressOf(sel),
                    form: contactForm({ ...sel, ...pickContact(body.contact) }),
                    formErrors: res.errors,
                });
            }
            sel = { ...sel, ...res.values };
            return await finishQuote(sel, history, response, body.sessionId);
        }

        const field = pendingField(sel);
        const text = typeof question === "string" ? question.trim() : "";
        if (!text) {
            const step = field ? { text: questionText(field, sel), key: field } : (contactReady(sel) ? { text: "", key: null } : { text: FORM_INTRO, key: FORM });
            return send(response, sel, step.text, step.key);
        }

        // --- An answer the backend can map on its own (every chip click). ---
        if (field) {
            if (field === "timeline" && tooLate(text)) {
                return send(response, sel, TIMELINE_LIMIT(), field);
            }
            const v = mapAnswer(field, text, sel);
            if (v) {
                sel = { ...sel, [field]: v };
                const step = nextStep(sel);
                return send(response, sel, ackText(field, sel) + "\n\n" + step.text, step.key);
            }
        }

        // --- A survey-time button under the finished quote. ---
        const afterQuote = !field && contactReady(sel);
        if (afterQuote && !sel.survey_time) {
            const picked = SURVEY_TIMES.find((t) => norm(t) === norm(text));
            if (picked) {
                sel = { ...sel, survey_time: picked };
                await inBackground(sendSurveyEmail(sel));
                const when = /^mindegy/i.test(picked) ? "" : ` A felmérést lehetőleg **${picked.toLowerCase()}** egyeztetjük.`;
                return send(response, sel, `Köszönöm, rögzítettem!${when} Kollégánk hamarosan hívja.`, null);
            }
        }

        // --- Everything else goes to the model. ---
        const mode = field ? "question" : (afterQuote ? "done" : "form");
        const ai = await askModel(sel, history, text, field, mode);

        const reading = ai.ok ? interpretModel(ai.text, mode === "question" ? field : null, sel) : null;
        if (reading) reading.said = withoutPrice(reading.said, mode);
        const afterQuoteKey = sel.survey_time ? null : SURVEY;

        if (!reading || !reading.said) {
            if (mode === "question") {
                return send(response, sel,
                    `Ezt most nem sikerült értelmeznem. Kérem, válasszon a lenti lehetőségek közül - ha kérdése van, hívjon minket bátran: **${PHONE}**.\n\n${questionText(field, sel)}`,
                    field);
            }
            if (mode === "form") {
                return send(response, sel, `Kérem, töltse ki a rövid űrlapot, és rögtön mutatom az alapárat. Kérdés esetén hívjon: **${PHONE}**.`, FORM);
            }
            return send(response, sel, `Erre most nem tudok válaszolni - kollégánk szívesen segít: **${PHONE}**.`, afterQuoteKey);
        }

        if (mode === "question") {
            const q = textOf(fieldDef(field).q, sel);
            if (reading.value) {
                sel = { ...sel, [field]: reading.value };
                // The next question follows from the backend, so a trailing
                // question the model tacked on (often the one just answered)
                // would sit right above it and read as a second question.
                const trimmed = reading.said.replace(/\s*[^.!?\n]*\?\s*$/, "").trim();
                const said = trimmed || reading.said;
                const note = textOf(fieldDef(field).after, sel);
                const step = nextStep(sel);
                return send(response, sel, said + (note ? `\n${note}` : "") + "\n\n" + step.text, step.key);
            }
            // Not an answer: the buttons for this question come back, so the
            // question has to be on screen with them. The model is told to
            // repeat it; if it did not, add it.
            const reasked = /\*\*[^*]*\?\*\*/.test(reading.said) || norm(reading.said).includes(norm(q));
            return send(response, sel, reasked ? reading.said : `${reading.said}\n\n${questionText(field, sel)}`, field);
        }
        return send(response, sel, reading.said, mode === "form" ? FORM : afterQuoteKey);
    } catch (error) {
        console.error("Function Crash:", error && error.stack || error);
        return response.status(500).json({ answer: `Elnézést, hiba történt. Kérjük, próbálja újra, vagy hívjon minket: ${PHONE}` });
    }
}

function pickContact(c) {
    const out = {};
    if (!c || typeof c !== "object") return out;
    for (const k of CONTACT_KEYS) if (has(c, k)) out[k] = oneLine(c[k]).slice(0, 200);
    const ct = CUSTOMER_TYPES.find((t) => norm(t.label) === norm(out.customer_type));
    if (ct) out.customer_type = ct.value; else delete out.customer_type;
    return out;
}

// ---------------------------------------------------------------------------
//  Deliver the finished quote: log it, e-mail the owner (with the whole
//  transcript), push it to the CRM, and return the customer's bubbles.
// ---------------------------------------------------------------------------
async function finishQuote(sel, history, response, sessionId) {
    const quote = assembleQuote(sel);
    const answer = renderCustomerQuote(quote, sel);

    console.log("\n========================================");
    console.log(`ÚJ ÁRBECSLÉS - ${quote.title}`);
    console.log(`Ügyfél: ${sel.name} | ${sel.phone} | ${sel.email || "-"} | ${sel.postal_code}`);
    console.log(`Alapár: ${formatHuf(quote.total)}-tól (${vatNote(quote)})`);
    console.log("========================================\n");

    // The customer is waiting for the price, so the e-mail and the CRM push run in
    // the background (waitUntil keeps the function alive for them).
    await inBackground(Promise.all([
        sendQuoteEmail(sel, quote, [
            ...(Array.isArray(history) ? history : []),
            { role: "assistant", content: answer },
        ]),
        sendLeadWebhook(sel, quote, "hu", { sessionId }),
    ]));

    return send(response, sel, answer, SURVEY, {
        done: true,
        call: { label: `Hívom most: ${PHONE}`, tel: PHONE.replace(/\s/g, "") },
        lead: { type: sel.projectType || null, total: quote.total, basis: quote.basis },
    });
}

function inBackground(work) {
    const safe = Promise.resolve(work).catch((e) => console.error("Háttérfeladat hiba:", e && e.message));
    if (hasVercelWaitUntil()) {
        waitUntil(safe);
        return Promise.resolve();
    }
    // Without Vercel's request context the work would die with the response.
    return safe;
}

// ---------------------------------------------------------------------------
//  ZOHO FLOW WEBHOOK
//  Fires once, from the server, the moment a quote is finished - the only point
//  where the contact details and the priced quote both exist.
//
//  The URL lives in ZOHO_FLOW_WEBHOOK_URL and is read here, in the API route.
//  It must never reach the browser: a Zoho Flow URL carries its own token in
//  the path, so anyone holding it can inject leads into the CRM. Nothing in
//  public/ references it, and the widget never sees it.
//
//  Failure is deliberately silent for the customer. Their quote is already
//  computed; a CRM that is down, slow or misconfigured must not turn that into
//  an error on screen. It is logged for the owner instead. The request is also
//  capped by a timeout, because on a serverless function an un-timed fetch to a
//  hanging endpoint holds the customer's reply hostage until the platform kills
//  the whole invocation.
// ---------------------------------------------------------------------------
const WEBHOOK_TIMEOUT_MS = 5000;
const webhookLine = (v) => String(v == null ? "" : v).replace(/[\r\n]+/g, " ").trim();

// Is Vercel's per-request context actually present, with a waitUntil on it?
// @vercel/functions' waitUntil does nothing at all, silently, without it.
function hasVercelWaitUntil() {
    try {
        const ctx = globalThis[Symbol.for("@vercel/request-context")]?.get?.();
        return typeof ctx?.waitUntil === "function";
    } catch (e) {
        return false;
    }
}

async function sendLeadWebhook(sel, quote, lang, meta = {}) {
    const url = (process.env.ZOHO_FLOW_WEBHOOK_URL || "").trim();
    if (!url) return { ok: false, skipped: "ZOHO_FLOW_WEBHOOK_URL nincs beállítva" };
    if (url === "paste-your-real-url-here") {
        console.warn("Zoho webhook kihagyva: a ZOHO_FLOW_WEBHOOK_URL meg a helykitolto ertek. Ird be a valodi URL-t (.env.local helyben, Vercel Environment Variables elesben).");
        return { ok: false, skipped: "placeholder" };
    }
    // https only, so the lead's contact details are never posted in the clear.
    // localhost is the one exception, for testing against a local catcher.
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url);
    if (!/^https:\/\//i.test(url) && !isLocal) {
        console.warn("Zoho webhook kihagyva: a ZOHO_FLOW_WEBHOOK_URL nem https URL.");
        return { ok: false, error: "insecure_url" };
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), WEBHOOK_TIMEOUT_MS);
    try {
        const ct = CUSTOMER_TYPES.find((c) => c.value === sel.customer_type);
        const payload = {
            // Lead channel. The website contact form posts to the same Zoho Flow
            // webhook with source "website form", so the two stay distinguishable.
            source: "Chatbot",
            submitted_at: new Date().toISOString(),
            session_id: webhookLine(meta.sessionId) || null,
            language: lang,

            name: webhookLine(sel.name) || null,
            phone: webhookLine(sel.phone) || null,
            email: webhookLine(sel.email) || null,

            // What the customer gave: a settlement or postcode, NOT a street address.
            address: webhookLine(sel.postal_code) || null,
            address_precision: "city_or_postcode",

            job_type: quote.title || null,
            // Key must be exactly "job": the Zoho Flow automation maps this name.
            job: [
                ...summaryPairs(sel).map(([k, v]) => `${k}: ${v}`),
                ct ? `Ügyfél típusa: ${ct.label}` : null,
                sel.survey_time ? `Felmérés: ${sel.survey_time}` : null,
            ].filter(Boolean).join(" · "),
            job_details: Object.fromEntries(projectOrder(sel).map((f) => [f, sel[f] || null])),

            quote_currency: "HUF",
            // A starting price, not a range: low, high and total are the same
            // floor, and quote_basis says so.
            quote_low: quote.total,
            quote_high: quote.total,
            quote_total: quote.total,
            quote_basis: "floor",
            quote_vat: quote.basis,
            quote_formatted: `${formatHuf(quote.total)}-tól`,
            quote_items: quote.items.map((i) => ({ label: i.label, low: i.amount, high: i.amount })),
        };

        // For checking the Zoho Flow mapping; contact details stay out of the logs.
        console.log("[zoho payload]", JSON.stringify({ ...payload, name: "***", phone: "***", email: "***" }));
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: ac.signal,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            console.error(`Zoho webhook HTTP ${res.status}: ${body.slice(0, 300)}`);
            return { ok: false, status: res.status };
        }
        console.log("Zoho webhook elkuldve.");
        return { ok: true };
    } catch (err) {
        const why = err && err.name === "AbortError"
            ? `nem valaszolt ${WEBHOOK_TIMEOUT_MS} ms alatt`
            : (err && err.message) || String(err);
        console.error("Zoho webhook sikertelen:", why);
        return { ok: false, error: why };
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
//  E-mail (Resend)
// ---------------------------------------------------------------------------
async function resendSend({ from, to, subject, html, text, replyTo }) {
    const key = (process.env.RESEND_API_KEY || "").trim();
    if (!key) return { ok: false, error: "RESEND_API_KEY nincs beállítva a környezetben." };
    if (/[^\x20-\x7E]/.test(key)) return { ok: false, error: "A RESEND_API_KEY nem ASCII karaktereket tartalmaz." };
    if (!to) return { ok: false, error: "Nincs címzett (LEAD_EMAIL_TO)." };
    const payload = { from, to: [to], subject, html };
    if (text) payload.text = text;
    if (replyTo) payload.reply_to = replyTo;
    // This e-mail IS the lead, so a passing failure gets one more try. A rejected
    // request (bad key, unverified sender) would only fail the same way again.
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
                signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
                body: JSON.stringify(payload),
            });
            const result = await res.json().catch(() => ({}));
            if (res.ok) return { ok: true, id: result.id };
            last = { ok: false, status: res.status, error: (result && (result.message || result.name)) || JSON.stringify(result) };
            if (res.status < 500 && res.status !== 429) return last;
        } catch (e) {
            last = { ok: false, error: e.message };
        }
    }
    return last;
}
const EMAIL_TIMEOUT_MS = 6000;

// The owner's phone shows the subject before anything else, so the number to
// ring is in it, and at the top of the body as a tap-to-call link.
const callLink = (phone) => `<p style="font-size:16px"><b>Hívd:</b> <a href="tel:${esc(String(phone).replace(/[^\d+]/g, ""))}">${esc(phone)}</a></p>`;
const PHONE_IN_TEXT = /(?:\+?36|06)[\s\-\/]*\d{1,2}[\s\-\/]*\d{3}[\s\-\/]*\d{3,4}/;

async function sendSurveyEmail(sel) {
    if (!process.env.RESEND_API_KEY) return false;
    const subject = `Felmérés: ${oneLine(sel.name)}, ${oneLine(sel.phone)} - ${oneLine(sel.survey_time)}`;
    const text = `${oneLine(sel.name)} a kész árbecslés után megadta, mikor jó a felmérés: ${oneLine(sel.survey_time)}.\nTelefon: ${oneLine(sel.phone)}\nTelepülés: ${oneLine(sel.postal_code)}`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${callLink(sel.phone)}<p>${esc(sel.name)} a kész árbecslés után megadta, mikor jó a felmérés: <b>${esc(sel.survey_time)}</b>.</p><p>Település: ${esc(sel.postal_code)}</p></div>`;
    const sent = await resendSend({ from: leadFrom(), to: leadTo(), subject, html, text });
    if (!sent.ok) console.error("Felmérés e-mail hiba:", sent.error);
    return sent.ok;
}

function contactPairs(s) {
    const ct = CUSTOMER_TYPES.find((c) => c.value === s.customer_type);
    const pairs = [];
    if (s.name) pairs.push(["Név", s.name]);
    if (s.phone) pairs.push(["Telefon", s.phone]);
    if (s.email) pairs.push(["E-mail", s.email]);
    if (s.postal_code) pairs.push(["Település", s.postal_code]);
    if (ct) pairs.push(["Ügyfél típusa", ct.label]);
    if (s.survey_time) pairs.push(["Felmérés időpontja", s.survey_time]);
    return pairs;
}

// Owner copy of a finished quote. Deliberately plain - a styled template is what
// lands in Gmail's Promotions tab, and this is a work notification. It carries a
// real text/plain part and replies straight to the customer when they gave an
// e-mail address.
async function sendQuoteEmail(sel, quote, transcript) {
    if (!process.env.RESEND_API_KEY) {
        console.log("Nincs RESEND_API_KEY - az e-mail kimarad. A lead a fenti logban szerepel.");
        return false;
    }
    const cp = contactPairs(sel);
    const work = summaryPairs(sel);
    const net = quote.basis === "gross" ? ` (nettó ${formatHuf(quote.netTotal)} + ÁFA)` : "";

    const start = has(sel, "timeline") ? labelFor("timeline", sel.timeline, sel) : "";
    const lines = [`Új árbecslés-kérés érkezett a weboldali asszisztensen keresztül (${FLOW.BOT.service}).`, ""];
    lines.push("ÜGYFÉL", ...cp.map(([k, v]) => `${k}: ${v}`), "");
    lines.push(`A MUNKA (${quote.title})`, ...work.map(([k, v]) => `${k}: ${v}`), "");
    lines.push(`BECSLÉS (${vatNote(quote)})`, ...quote.items.map((i) => `${i.label}: ${formatHuf(i.amount)}`));
    lines.push(`Alapár: ${formatHuf(quote.total)}-tól${net}`, "");
    lines.push("AMI AZ ALAPÁRON FELÜL JÖHET", ...quote.exclusions.map((e) => `- ${plain(e)}`));
    if (quote.flags.length) lines.push("", "FIGYELEM", ...quote.flags.map((f) => `- ${plain(f)}`));
    const tText = transcriptText(transcript);
    if (tText) lines.push("", "TELJES BESZÉLGETÉS", "", tText);

    const block = (title, rows) => `<p><b>${esc(title)}</b><br>${rows.map(([k, v]) => `${esc(k)}: ${esc(v)}`).join("<br>")}</p>`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">
        ${callLink(sel.phone)}
        <p>Új árbecslés-kérés érkezett a weboldali asszisztensen keresztül (${esc(FLOW.BOT.service)}).</p>
        ${block("Ügyfél", cp)}
        ${block(`A munka (${quote.title})`, work)}
        <p><b>Becslés (${esc(vatNote(quote))})</b><br>${quote.items.map((i) => `${esc(i.label)}: ${formatHuf(i.amount)}`).join("<br>")}<br><b>Alapár: ${formatHuf(quote.total)}-tól</b>${esc(net)}</p>
        <p><b>Ami az alapáron felül jöhet</b><br>${quote.exclusions.map((e) => `- ${esc(plain(e))}`).join("<br>")}</p>
        ${quote.flags.length ? `<p><b>Figyelem</b><br>${quote.flags.map((f) => `- ${esc(plain(f))}`).join("<br>")}</p>` : ""}
        ${transcriptHtml(transcript) ? `<p><b>Teljes beszélgetés</b></p>${transcriptHtml(transcript)}` : ""}
      </div>`;

    const subject = `Árbecslés: ${oneLine(sel.name) || "névtelen"}, ${oneLine(sel.phone)} - ${quote.title}, ${oneLine(sel.postal_code) || "?"} - ${formatHuf(quote.total)}-tól${start ? ` - Kezdés: ${start}` : ""}`;
    const sent = await resendSend({
        from: leadFrom(), to: leadTo(), subject, html, text: lines.join("\n"),
        replyTo: sel.email && !emailIssue(sel.email) ? oneLine(sel.email) : undefined,
    });
    if (sent.ok) console.log("Árbecslés e-mail elküldve:", sent.id);
    else console.error("Resend hiba:", sent.error);
    return sent.ok;
}

// Owner copy of a conversation that never reached a finished quote - which is
// most of them.
async function sendTranscriptEmail(sel, transcript, meta = {}) {
    const s = sel && typeof sel === "object" ? sel : {};
    const rows = transcriptHtml(transcript);
    if (!rows) return { ok: false, error: "Üres beszélgetés - nincs mit küldeni." };

    const pairs = [...contactPairs(s), ...(s.projectType ? summaryPairs(s) : [])];
    const flow = s.projectType ? FLOW.title(s) : "Nincs megadva";
    const when = new Date().toLocaleString("hu-HU", { timeZone: "Europe/Budapest" });
    const cut = (x) => oneLine(x).slice(0, 160);
    const lead = meta.test
        ? "Ez egy teszt e-mail, amit te magad indítottál. Ha megérkezett, az e-mail küldés működik."
        : meta.callback
            ? "Az érdeklődő visszahívást kért, még a kész árbecslés előtt. Amit eddig megadott, lent olvasod."
            : "Ez a beszélgetés nem jutott el a kész árbecslésig, de az érdeklődő elmondta, amit lent olvasol.";
    const gavePhone = !meta.test && !meta.callback && Array.isArray(transcript)
        && transcript.some((m) => m && m.role === "user" && PHONE_IN_TEXT.test(String(m.content)));

    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">
        ${meta.callback && s.phone ? callLink(s.phone) : ""}
        <p>${esc(lead)}</p>
        <p><b>Amit eddig tudunk (${esc(flow)})</b></p>
        ${pairs.length ? pairs.map(([k, v]) => `<p style="margin:4px 0"><b>${esc(k)}:</b> ${esc(v)}</p>`).join("") : `<p style="margin:4px 0;color:#6b7280">Még semmit nem adott meg.</p>`}
        <p style="margin:4px 0;font-size:12px;color:#6b7280">Időpont: ${esc(when)} · Ügyfél üzenetei: ${customerTurns(transcript)} · Azonosító: ${esc(cut(meta.sessionId) || "-")}</p>
        ${meta.pageUrl ? `<p style="margin:4px 0;font-size:12px;color:#6b7280">Oldal: ${esc(cut(meta.pageUrl))}</p>` : ""}
        ${meta.reason ? `<p style="margin:4px 0;font-size:12px;color:#6b7280">Kiváltó esemény: ${esc(cut(meta.reason))}</p>` : ""}
        <p><b>Teljes beszélgetés</b></p>
        ${rows}
      </div>`;
    const textBody = [
        lead, "", `AMIT EDDIG TUDUNK (${flow})`,
        ...(pairs.length ? pairs.map(([k, v]) => `${k}: ${v}`) : ["Még semmit nem adott meg."]),
        "", `Időpont: ${when} | Ügyfél üzenetei: ${customerTurns(transcript)}`,
        meta.pageUrl ? `Oldal: ${cut(meta.pageUrl)}` : null,
        "", "TELJES BESZÉLGETÉS", "", transcriptText(transcript),
    ].filter((l) => l !== null).join("\n");

    const who = s.name ? oneLine(s.name) : "névtelen érdeklődő";
    const subject = meta.test
        ? "Teszt: a Banacraft chatbot e-mail küldése működik"
        : meta.callback
            ? `VISSZAHÍVÁS: ${who}, ${oneLine(s.phone)} - ${flow}`
            : `${gavePhone ? "TELEFONSZÁMOT ÍRT - " : ""}Félbehagyott beszélgetés: ${who} - ${flow}${meta.update ? " (frissítés)" : ""}`;

    const sent = await resendSend({
        from: leadFrom(), to: leadTo(), subject, html, text: textBody,
        replyTo: s.email && !emailIssue(s.email) ? oneLine(s.email) : undefined,
    });
    if (sent.ok) console.log("Beszélgetés-másolat elküldve:", sent.id);
    else console.error("Beszélgetés-másolat hiba:", sent.error);
    return sent;
}

// ---------------------------------------------------------------------------
//  SELF-TEST - GET /api/faq-agent?selftest=1 sends a sample transcript to
//  LEAD_EMAIL_TO and reports what Resend answered. It can never send anywhere
//  else, and it is rate-limited. Set OWNER_TEST_KEY to require ?selftest=<key>.
// ---------------------------------------------------------------------------
function maskEmail(a) {
    const s = String(a || "");
    const at = s.indexOf("@");
    if (at < 1) return s ? "***" : "(nincs beállítva)";
    const user = s.slice(0, at);
    return `${user.slice(0, 2)}${"*".repeat(Math.max(1, user.length - 2))}${s.slice(at)}`;
}
function safeEqualStr(a, b) {
    a = String(a == null ? "" : a); b = String(b == null ? "" : b);
    if (a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
}

async function runSelfTest(request, response, ip) {
    response.setHeader("Cache-Control", "no-store");
    const given = String((request.query && request.query.selftest) || "");
    const wanted = (process.env.OWNER_TEST_KEY || "").trim();
    if (wanted && !safeEqualStr(given, wanted)) {
        return response.status(401).json({ ok: false, error: "Rossz vagy hiányzó selftest kulcs." });
    }
    const rl = rateLimit(`selftest:${ip}`, RL_SELFTEST.limit, RL_SELFTEST.windowMs);
    if (!rl.ok) return response.status(429).json({ ok: false, error: `Túl sok teszt. Próbáld újra ${rl.retryAfter} másodperc múlva.` });

    const checks = {
        RESEND_API_KEY: process.env.RESEND_API_KEY ? "beállítva" : "HIÁNYZIK",
        LEAD_EMAIL_TO: maskEmail(leadTo()),
        LEAD_EMAIL_FROM: leadFrom(),
        AI_PROVIDER: (process.env.AI_PROVIDER || "openai").toLowerCase(),
        OWNER_TEST_KEY: wanted ? "beállítva" : "nincs beállítva (a teszt bárkinek elérhető, de csak a tulajdonosnak küld)",
    };
    const sent = await sendTranscriptEmail(
        { name: "Teszt Elek", phone: "+36 30 000 0000", postal_code: "Budapest" },
        [
            { role: "assistant", content: "Üdvözlöm! Miben segíthetünk?" },
            { role: "user", content: "Szeretnék árbecslést kérni." },
        ],
        { test: true, sessionId: "selftest", reason: "manuális teszt" }
    );
    return response.status(sent.ok ? 200 : 500).json({
        ok: !!sent.ok,
        message: sent.ok
            ? `Teszt e-mail elküldve ide: ${maskEmail(leadTo())}. Nézd meg a postafiókot (a spam mappát is).`
            : "Az e-mail küldés NEM sikerült. A 'resendError' mezőben ott az ok.",
        resendId: sent.id || null,
        resendError: sent.ok ? null : sent.error,
        checks,
    });
}

// Exported for the flow tests (no effect in production).
export { mapAnswer, parseArea, phoneIssue, acceptModelValue, interpretModel, pendingField, projectOrder, optionsFor, sanitizeState, assembleQuote, renderCustomerQuote, summaryPairs, questionText, validateContactForm, tooLate };
