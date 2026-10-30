// Flow tests - run with `node test-flow.mjs`. No API keys needed: every path
// here is one the backend answers without the model (button clicks), and with
// no RESEND_API_KEY / ZOHO_FLOW_WEBHOOK_URL nothing is sent anywhere.
//
//  1. A random walk through EVERY branch of the flow, clicking random buttons
//     (random subsets on multi-selects), then submitting the contact form.
//     Every step must offer buttons or the form; every finished quote must be
//     a positive, whole, itemised floor whose lines add up to the total.
//  2. Fixed scenarios printed with their price, so a rate edit that drifts
//     off-market is visible at a glance.
//  3. Guards: a typed >90-day timeline is refused, a bad contact form bounces,
//     a tampered state is cleaned.
import handler, { projectOrder, optionsFor, sanitizeState, parseArea, phoneIssue, mapAnswer, tooLate, assembleQuote } from "./api/faq-agent.js";
import * as FLOW from "./lib/flow.js";

delete process.env.RESEND_API_KEY;
delete process.env.ZOHO_FLOW_WEBHOOK_URL;
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;

const quiet = process.argv.includes("--verbose") ? null : console.log;
if (quiet) console.log = () => {};
const log = (...a) => (quiet || console.log)(...a);

let failures = 0;
const fail = (msg, ctx) => { failures++; log("  FAIL:", msg, ctx ? JSON.stringify(ctx).slice(0, 600) : ""); };

let ipSeq = 0;
async function call(body) {
    let out = null;
    const req = { method: "POST", body, headers: { "x-forwarded-for": `10.0.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` }, socket: {} };
    const res = {
        statusCode: 200,
        setHeader() {},
        status(c) { this.statusCode = c; return this; },
        json(d) { out = d; return this; },
        end() { return this; },
    };
    await handler(req, res);
    return { status: res.statusCode, data: out };
}

const CONTACT = { name: "Teszt Elek", phone: "+36 30 123 4567", postal_code: "Budapest XI.", email: "", customer_type: "Magánszemély", survey_time: "" };
const rnd = (n) => Math.floor(Math.random() * n);

// Click through a conversation. `choose(field, labels, data)` returns the text
// to send for the current question.
async function run(choose, contact = CONTACT) {
    const history = [];
    let { data } = await call({ action: "start", state: {} });
    let guard = 0;
    while (!data.form && !data.done) {
        if (++guard > 60) { fail("flow did not end", data.state); return null; }
        if (!data.chips || !data.chips.length) { fail("question without buttons", data); return null; }
        const text = choose(data);
        history.push({ role: "assistant", content: data.answer }, { role: "user", content: text });
        const prevProgress = data.progress;
        ({ data } = await call({ question: text, history, state: data.state }));
        if (data.progress <= prevProgress && !data.form) fail("answer did not advance the flow", { text, state: data.state, answer: data.answer });
    }
    const r = await call({ contact, history, state: data.state });
    return r.data;
}

function checkQuote(d, ctx) {
    if (!d || !d.done) return fail("no finished quote", { ctx, d });
    const total = d.lead && d.lead.total;
    if (!(total > 0) || total % 1000 !== 0) fail("total not a positive whole-thousand amount", { ctx, total });
    if (!/Alapár: [\d\s]+Ft-tól/.test(d.answer)) fail("no 'Alapár ... Ft-tól' line", { ctx });
    const amounts = [...d.answer.split("[[SPLIT]]")[0].matchAll(/^• .* - \*\*([\d\s]+)Ft\*\*$/gm)].map((m) => Number(m[1].replace(/\D/g, "")));
    if (!amounts.length) fail("no itemised lines", { ctx });
    const sum = amounts.reduce((s, a) => s + a, 0);
    if (sum !== total) fail("items do not add up to the total", { ctx, sum, total });
    if (/NaN|undefined|null/.test(d.answer)) fail("NaN/undefined in the quote text", { ctx, answer: d.answer });
    return total;
}

// ---------------------------------------------------------------------------
log(`\n=== ${FLOW.BOT.id}: random walk ===`);
const N = Number(process.env.WALKS) || 600;
const seenTypes = new Set();
for (let i = 0; i < N; i++) {
    const d = await run((q) => {
        if (q.multi) {
            const picks = q.chips.filter(() => Math.random() < 0.35);
            return (picks.length ? picks : [q.chips[rnd(q.chips.length)]]).join(" · ");
        }
        return q.chips[rnd(q.chips.length)];
    }, { ...CONTACT, customer_type: ["Magánszemély", "Cég", "Intézmény", "Társasház"][rnd(4)] });
    if (d) {
        seenTypes.add(d.state.projectType);
        checkQuote(d, d.state);
        // Typing a bigger area must never give a smaller price (rounding aside).
        const areaField = projectOrder(d.state).find((f) => FLOW.FIELDS[f].type === "area");
        if (areaField && i % 10 === 0) {
            let prev = 0;
            for (let m2 = 5; m2 <= 1500; m2 += 5) {
                const t = assembleQuote({ ...d.state, [areaField]: String(m2) }).total;
                if (t < prev - 3000) { fail("bigger area came out cheaper", { m2, t, prev, state: d.state }); break; }
                prev = t;
            }
        }
    }
}
const allTypes = optionsFor("projectType", {}).map((o) => o.value);
for (const t of allTypes) if (!seenTypes.has(t)) fail(`project type never reached in the walk: ${t}`);
log(`${N} conversations, ${seenTypes.size}/${allTypes.length} project types reached`);

// ---------------------------------------------------------------------------
log(`\n=== ${FLOW.BOT.id}: scenarios ===`);
for (const sc of FLOW.TEST_SCENARIOS || []) {
    const d = await run((q) => {
        const field = Object.keys(sc.answers).find((f) => f === pendingOf(q.state));
        const want = field ? sc.answers[field] : null;
        if (want == null) return q.chips[0];
        const labels = [].concat(want);
        const missing = labels.filter((l) => !q.chips.includes(l) && !/^\d+$/.test(l));
        if (missing.length) {
            // Report once and carry on with the first button, so one typo in a
            // scenario cannot loop the walk until the history cap trips.
            fail(`scenario "${sc.name}": no button "${missing.join('", "')}"`, q.chips);
            delete sc.answers[field];
            return q.chips[0];
        }
        return labels.join(" · ");
    }, { ...CONTACT, customer_type: sc.customer || "Magánszemély" });
    const total = checkQuote(d, sc.name);
    if (total != null) {
        log(`\n--- ${sc.name}: ${total.toLocaleString("hu-HU")} Ft-tól (${d.lead.basis})`);
        if (sc.min && total < sc.min) fail(`scenario "${sc.name}" below its sanity floor`, { total, min: sc.min });
        if (sc.max && total > sc.max) fail(`scenario "${sc.name}" above its sanity ceiling`, { total, max: sc.max });
        if (process.argv.includes("--show")) log(d.answer.replace(/\[\[SPLIT\]\]/g, "\n---"));
        else log(d.answer.split("[[SPLIT]]")[0]);
    }
}

function pendingOf(state) {
    for (const f of projectOrder(state)) if (state[f] == null || state[f] === "") return f;
    return null;
}

// ---------------------------------------------------------------------------
log(`\n=== ${FLOW.BOT.id}: guards ===`);
{
    // Walk to the timeline question, then type a far-off start.
    let { data } = await call({ action: "start", state: {} });
    let guard = 0;
    while (pendingOf(data.state) !== "timeline" && !data.form && guard++ < 60) {
        ({ data } = await call({ question: data.multi ? data.chips[data.chips.length - 1] : data.chips[0], history: [], state: data.state }));
    }
    const late = await call({ question: "8 hónap múlva lenne jó", history: [], state: data.state });
    if (!/90 napon/.test(late.data.answer) || late.data.state.timeline) fail("far-off timeline was not refused", late.data);
    else log("far-off timeline refused: ok");

    const ok = await call({ question: "30 napon belül", history: [], state: data.state });
    if (!ok.data.form) fail("timeline chip did not open the contact form", ok.data);

    const bad = await call({ contact: { name: "A", phone: "123", postal_code: "", customer_type: "" }, history: [], state: ok.data.state });
    const errs = Object.keys(bad.data.formErrors || {});
    if (!["name", "phone", "postal_code", "customer_type"].every((k) => errs.includes(k))) fail("bad contact form not rejected field by field", bad.data);
    else log("bad contact form rejected: ok");

    // No AI key: a typed, unmappable answer falls back to the buttons.
    const typed = await call({ question: "hát ezt nem tudom így megmondani", history: [], state: {} });
    if (!typed.data.chips.length || !/értelmeznem/.test(typed.data.answer)) fail("no-AI fallback did not re-offer the buttons", typed.data);
    else log("no-AI fallback: ok");

    const dirty = sanitizeState({ projectType: "__proto__", timeline: "d365", name: "x\r\ny", customer_type: "admin" });
    if (dirty.projectType || dirty.timeline || dirty.customer_type || /[\r\n]/.test(dirty.name)) fail("tampered state not cleaned", dirty);
    else log("tampered state cleaned: ok");

    // --- Typed answers read without the model ---
    const areas = [["65", 65], ["kb. 65 nm", 65], ["65 m²-es", 65], ["1 200 m2", 1200], ["1.200", 1200], ["12,5 nm", 12.5],
        ["2 szobás", null], ["3 emelet", null], ["2 szobás, 60 nm", null], ["5 db", null], ["nem tudom", null]];
    for (const [text, want] of areas) if (parseArea(text) !== want) fail(`parseArea("${text}")`, { got: parseArea(text), want });
    const tl = (t) => mapAnswer("timeline", t, {});
    if (tl("amint lehet.") !== "asap" || tl("AMINT LEHET") !== "asap") fail("typed button text not matched");
    if (tl("90 napon") !== "d90") fail("unique start of a label not matched");
    if (tl("napon") || tl("hát majd meglátjuk") || tl("3")) fail("loose match took an ambiguous answer");
    const firstType = optionsFor("projectType", {})[0];
    const noAccents = firstType.label.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (mapAnswer("projectType", noAccents, {}) !== firstType.value) fail("label without accents not matched", noAccents);

    // --- "Later" depends on today ---
    const oct30 = new Date(2026, 9, 30), feb10 = new Date(2026, 1, 10), jul1 = new Date(2026, 6, 1);
    const later = [["télen", oct30, false], ["tavasszal", oct30, true], ["jövőre", oct30, false], ["jövőre", jul1, true], ["tavasszal", feb10, false],
        ["ősszel", feb10, true], ["nyáron", jul1, false], ["8 hónap múlva", oct30, true], ["öt hónap múlva", oct30, true], ["fél év múlva", oct30, true],
        ["3 hónapon belül", oct30, false], ["két héten belül", oct30, false], ["fél éve vettük a házat", oct30, false]];
    for (const [text, when, want] of later) if (tooLate(text, when) !== want) fail(`tooLate("${text}", ${when.toDateString()})`, { want });

    if (phoneIssue("1 234 5678") || phoneIssue("+36 30 123 4567") || !phoneIssue("11111111") || !phoneIssue("123")) fail("phone check");
}

// ---------------------------------------------------------------------------
log(`\n=== ${FLOW.BOT.id}: after the quote, callback, AI and e-mail failures (mocked) ===`);
{
    const realFetch = globalThis.fetch;
    const stub = (fn) => { globalThis.fetch = fn; };
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    const toFirstQuestion = async () => (await call({ action: "start", state: {} })).data;

    // Finished quote offers survey times and a call button; picking one e-mails the owner.
    const done = await run((q) => q.multi ? q.chips[0] : q.chips[0]);
    if (!done.done || !done.chips.length || !done.call || !done.call.tel) fail("quote has no next step", done);
    process.env.RESEND_API_KEY = "test";
    const mails = [];
    stub(async (url, init) => { mails.push({ url, body: JSON.parse(init.body) }); return json({ id: "x" }); });
    const picked = await call({ question: done.chips[0], history: [], state: done.state });
    if (picked.data.state.survey_time !== done.chips[0]) fail("survey time not recorded", picked.data);
    if (picked.data.chips.length) fail("survey buttons still offered after picking", picked.data);
    if (mails.length !== 1 || !/Felmérés/.test(mails[0].body.subject) || !mails[0].body.subject.includes(CONTACT.phone)) fail("survey e-mail wrong", mails);

    // The finished-quote e-mail subject carries the phone number and the price.
    mails.length = 0;
    const fresh = await call({ contact: CONTACT, history: [], state: { ...done.state, survey_time: undefined } });
    const subject = mails[0] && mails[0].body.subject;
    if (!fresh.data.done || !subject || !subject.includes(CONTACT.phone) || !/Ft-tól/.test(subject)) fail("quote e-mail subject", subject);

    // Callback from the first question: mail sent, flow carries on, name prefilled later.
    mails.length = 0;
    const q0 = await toFirstQuestion();
    const history = [{ role: "assistant", content: "Üdv" }];
    const cb = await call({ action: "callback", contact: { name: "Teszt Elek", phone: "+36 30 123 4567" }, history, state: q0.state });
    if (!cb.data.callbackDone || !cb.data.chips.length) fail("callback did not carry on", cb.data);
    if (!mails[0] || !/^VISSZAHÍVÁS/.test(mails[0].body.subject)) fail("callback e-mail", mails[0] && mails[0].body.subject);
    const cbBad = await call({ action: "callback", contact: { name: "", phone: "12" }, history, state: {} });
    if (!cbBad.data.formErrors || !cbBad.data.formErrors.name || !cbBad.data.formErrors.phone) fail("bad callback not rejected", cbBad.data);

    // Resend: a passing 500 is retried; a callback that cannot be delivered says so.
    let tries = 0;
    stub(async () => (++tries === 1 ? json({ message: "down" }, 500) : json({ id: "y" })));
    const retried = await call({ action: "callback", contact: { name: "Teszt Elek", phone: "+36 30 123 4567" }, history, state: {} });
    if (tries !== 2 || !retried.data.callbackDone) fail("e-mail not retried", { tries });
    tries = 0;
    stub(async () => { tries++; return json({ message: "invalid sender" }, 403); });
    const failed = await call({ action: "callback", contact: { name: "Teszt Elek", phone: "+36 30 123 4567" }, history, state: {} });
    if (tries !== 1 || !failed.data.callbackFailed || failed.data.callbackDone) fail("hard e-mail failure mishandled", { tries, d: failed.data });
    delete process.env.RESEND_API_KEY;

    // AI: the model names a price -> replaced. Valid tag -> answer recorded.
    process.env.AI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test";
    const reply = (obj) => json({ choices: [{ message: { content: JSON.stringify(obj) } }] });
    const firstValue = optionsFor("projectType", {})[0].value;
    stub(async () => reply({ valasz: "Kb. 250 000 Ft lesz.", ertek: null }));
    const priced = await call({ question: "mennyibe kerülne kb ez az egész?", history: [], state: {} });
    if (/250 000/.test(priced.data.answer) || !priced.data.chips.length) fail("model's price reached the customer", priced.data);
    stub(async () => reply({ valasz: "Értem.", ertek: firstValue }));
    const tagged = await call({ question: "ezt a munkát kérném el szépen", history: [], state: {} });
    if (tagged.data.state.projectType !== firstValue) fail("model's answer not recorded", tagged.data);

    // AI: OpenAI down -> Gemini answers. Gemini rejects the thinking setting -> retried without it.
    process.env.GEMINI_API_KEY = "test";
    const geminiCalls = [];
    stub(async (url, init) => {
        if (String(url).includes("openai")) throw new Error("timeout");
        const body = JSON.parse(init.body);
        geminiCalls.push({ url: String(url), thinking: body.generationConfig.thinkingConfig, key: init.headers["x-goog-api-key"] });
        if (body.generationConfig.thinkingConfig) return json({ error: { message: "bad thinking" } }, 400);
        return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ valasz: "Segítek.", ertek: null }) }] } }] });
    });
    const failover = await call({ question: "van garancia a munkára?", history: [], state: {} });
    if (!/Segítek/.test(failover.data.answer)) fail("failover to the other provider", failover.data);
    if (geminiCalls.length !== 2 || geminiCalls[1].thinking) fail("gemini retry without thinking", geminiCalls);
    if (geminiCalls.some((c) => c.url.includes("key=")) || geminiCalls[0].key !== "test") fail("gemini key in the URL", geminiCalls);

    // AI: every provider down -> the buttons come back.
    stub(async () => { throw new Error("down"); });
    const allDown = await call({ question: "van garancia a munkára?", history: [], state: {} });
    if (!allDown.data.chips.length) fail("no buttons when the AI is down", allDown.data);

    delete process.env.AI_PROVIDER; delete process.env.OPENAI_API_KEY; delete process.env.GEMINI_API_KEY;
    globalThis.fetch = realFetch;
    log("mocked paths: done");
}

console.log = quiet || console.log;
console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll flow tests passed.");
process.exit(failures ? 1 : 0);
