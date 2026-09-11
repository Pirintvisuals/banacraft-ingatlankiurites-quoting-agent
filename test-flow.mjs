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
import handler, { projectOrder, optionsFor, sanitizeState } from "./api/faq-agent.js";
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
    if (d) { seenTypes.add(d.state.projectType); checkQuote(d, d.state); }
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
    const late = await call({ question: "jövő tavasszal lenne jó", history: [], state: data.state });
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
}

console.log = quiet || console.log;
console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll flow tests passed.");
process.exit(failures ? 1 : 0);
