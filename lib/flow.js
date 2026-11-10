// ============================================================================
//  BANACRAFT - INGATLANKIÜRÍTÉS, LOMTALANÍTÁS ÉS TAKARÍTÁS
//
//  Everything this bot knows about its trade: the questions (in order), their
//  buttons, the price model, and the facts the AI may repeat. The shared engine
//  in api/faq-agent.js reads only what is exported here.
//
//  PRICES ARE BANACRAFT'S OWN (Róbert, 2026-10-30): a rate per m³ of stuff that
//  depends on where the job is, with a minimum volume per area, +10% per floor
//  without a lift, and hazardous waste priced per m³ on top. The volume comes
//  from the floor area: an average home holds about half its m² in m³.
//
//  Takarítás and illegally dumped waste are too varied to price (Róbert's call),
//  as is anything over 100 m³ or further out than the counties around Pest: the
//  bot takes the details and promises a call instead of showing a price.
//
//  PRICING PRINCIPLE - a floor, never a range. Every band answer is priced at
//  its LOWER edge, so the number the customer sees can only go UP at the survey.
//  All amounts are NET Ft; the engine adds VAT for private customers.
// ============================================================================

export const BOT = {
    id: "banacraft-kiurites",
    service: "ingatlankiürítés, lomtalanítás és takarítás",
    phone: "+36 70 625 2014",
    email: "info@banacraft.hu",
    maxStartDays: 60,
};

// ---------------------------------------------------------------------------
//  PRICES (net Ft) - edit here only
// ---------------------------------------------------------------------------
const P = {
    // Per m³ all-in (packing, carrying, loading, transport, landfill fee), and the
    // smallest volume charged, by where the job is.
    perM3: { bp: 9900, pest: 10900, kornyek: 10900 },
    minM3: { bp: 4, pest: 5, kornyek: 8 },
    perFloorNoLift: 0.1,
    hazardPerM3: 29900, // paint, chemicals, oil, insulation
    customAboveM3: 100,
    // m³ of stuff per m² of floor. "normal" is Róbert's rule of thumb (half the
    // m²). The others are set by ratio to it from published figures (2026-11):
    //  - Hungarian clear-out firms put a whole furnished 50 m² flat at 6–10 m³
    //    and charge from a 2 m³ minimum, so "a few pieces" is roughly a fifth
    //    of a furnished home -> 0,1 (the lower edge, as a floor price should be)
    //  - a UK hoarder clearance of a small 2-bedroom house filled ~10 t, which
    //    at loose household-waste density is roughly 1 m³ per m² -> "tele" 1
    //  - "zsúfolt" sits between furnished and floor-to-ceiling -> 0,75
    // Róbert's 0,5 is above the market's furnished figure (his is loaded truck
    // volume); a 50 m² flat still lands at ~314 000 Ft gross, inside the
    // 150-350 ezer Ft that Budapest firms quote for a panel flat.
    fill: { ures: 0.1, normal: 0.5, zsufolt: 0.75, tele: 1 },
};

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
const opt = (label, value, extra) => ({ label, value, ...extra });
const NT = (extra) => opt("Nem tudom", "nem_tudom", extra);
const num = (n) => String(Math.round(n * 10) / 10).replace(".", ",");
const ft = (n) => Math.round(n).toLocaleString("hu-HU").replace(/\s/g, " ") + " Ft";

function optionOf(field, sel) {
    const f = FIELDS[field];
    const opts = typeof f.options === "function" ? f.options(sel) : f.options;
    return opts.find((o) => o.value === sel[field]) || null;
}
const labelOf = (field, sel) => (optionOf(field, sel) || {}).label || "";

// A band button is its lower edge, "Nem tudom" its default, a typed number itself.
function numberOf(sel, field) {
    const o = optionOf(field, sel);
    if (o && o.n != null) return o.n;
    const n = parseFloat(String(sel[field] || "").replace(",", "."));
    return n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
//  QUESTIONS
// ---------------------------------------------------------------------------
const HOUSE_LIKE = ["haz", "nyaralo"];
const FLAT_LIKE = ["lakas", "hagyatek", "iroda", "egyeb"];
const NO_PRICE = ["takaritas", "illegalis"];

const AREA = {
    flat: [opt("40 m² alatt", "f_lt40", { n: 30 }), opt("40–70 m²", "f_40_70", { n: 40 }), opt("70–120 m²", "f_70_120", { n: 70 }), opt("120 m² felett", "f_gt120", { n: 120 }), NT({ n: 45 })],
    house: [opt("80 m² alatt", "h_lt80", { n: 60 }), opt("80–120 m²", "h_80_120", { n: 80 }), opt("120–200 m²", "h_120_200", { n: 120 }), opt("200 m² felett", "h_gt200", { n: 200 }), NT({ n: 90 })],
    small: [opt("10 m² alatt", "s_lt10", { n: 6 }), opt("10–20 m²", "s_10_20", { n: 10 }), opt("20–40 m²", "s_20_40", { n: 20 }), opt("40 m² felett", "s_gt40", { n: 40 }), NT({ n: 12 })],
    hall: [opt("100 m² alatt", "c_lt100", { n: 70 }), opt("100–300 m²", "c_100_300", { n: 100 }), opt("300 m² felett", "c_gt300", { n: 300 }), NT({ n: 150 })],
    clean: [opt("50 m² alatt", "k_lt50", { n: 35 }), opt("50–100 m²", "k_50_100", { n: 50 }), opt("100–200 m²", "k_100_200", { n: 100 }), opt("200 m² felett", "k_gt200", { n: 200 }), NT({ n: 60 })],
};
function areaGroup(sel) {
    const pt = sel.projectType;
    if (pt === "takaritas") return "clean";
    if (HOUSE_LIKE.includes(pt)) return "house";
    if (pt === "pince" || pt === "garazs") return "small";
    if (pt === "csarnok") return "hall";
    return "flat";
}

// Loads that are easier to judge by eye than by floor area.
const VOLUME = [
    opt("Egy utánfutónyi (1–2 m³)", "v_u", { n: 1 }), opt("Egy kisteherautónyi (3–6 m³)", "v_k", { n: 3 }),
    opt("Egy nagy teherautónyi (8–15 m³)", "v_n", { n: 8 }), opt("Több teherautónyi (20 m³ felett)", "v_t", { n: 20 }), NT({ n: 3 }),
];

const ACCESS_FLAT = [
    opt("Földszint, vagy van lift", "f0", { floors: 0 }), opt("1. emelet, lift nélkül", "f1", { floors: 1 }),
    opt("2. emelet, lift nélkül", "f2", { floors: 2 }), opt("3. emelet, lift nélkül", "f3", { floors: 3 }),
    opt("4. emelet vagy feljebb, lift nélkül", "f4", { floors: 4 }),
];
const ACCESS_HOUSE = [opt("Csak a földszintről", "h0", { floors: 0 }), opt("Az emeletről vagy a tetőtérből is", "h1", { floors: 1 }), opt("A pincéből is", "hp", { floors: 1 })];

export const FIELDS = {
    projectType: {
        short: "Munka",
        q: "Miben segíthetünk?",
        hint: "Válassza ki, mit kellene kiüríteni, elszállítani vagy kitakarítani.",
        options: [
            opt("Lakás kiürítése", "lakas"), opt("Családi ház kiürítése", "haz"), opt("Nyaraló kiürítése", "nyaralo"),
            opt("Hagyatéki ingatlan kiürítése", "hagyatek"), opt("Pince vagy padlás", "pince"), opt("Garázs, tároló, műhely", "garazs"),
            opt("Iroda, üzlet", "iroda"), opt("Raktár, üzem, csarnok", "csarnok"), opt("Telek, udvar", "telek"),
            opt("Illegálisan lerakott hulladék", "illegalis"), opt("Takarítás", "takaritas"), opt("Egyéb", "egyeb"),
        ],
    },
    region: {
        short: "Helyszín",
        q: "Hol van az ingatlan?",
        hint: "Pest környéki megye: Nógrád, Heves, Jász-Nagykun-Szolnok, Bács-Kiskun, Fejér, Komárom-Esztergom.",
        options: [opt("Budapest", "bp"), opt("Pest megye", "pest"), opt("Pest környéki megye", "kornyek"), opt("Távolabb", "tavol")],
    },

    // --- Kiürítés ---
    size: {
        type: "number",
        unit: "m²",
        short: "Alapterület",
        q: (sel) => sel.projectType === "takaritas" ? "Mekkora a takarítandó terület?" : "Mekkora az alapterület?",
        options: (sel) => AREA[areaGroup(sel)],
        values: [...new Set(Object.values(AREA).flat().map((o) => o.value))],
    },
    fullness: {
        short: "Telítettség",
        q: "Mennyire van tele?",
        hint: "Ebből tudjuk, hány köbméter lomot kell elvinni.",
        options: [opt("Szinte üres, csak néhány darab", "ures"), opt("Normál berendezés", "normal"), opt("Zsúfolt, sok holmi", "zsufolt"), opt("Padlótól plafonig tele", "tele")],
    },
    volume: {
        type: "number",
        unit: "m³",
        short: "Mennyiség",
        q: (sel) => sel.projectType === "illegalis" ? "Körülbelül mekkora a lerakott hulladék?" : "Körülbelül mennyi lomot kell elvinni?",
        options: VOLUME,
    },
    access: {
        short: "Emelet / lift",
        q: (sel) => HOUSE_LIKE.includes(sel.projectType) ? "Honnan kell kihordani?" : "Hányadik emeleten van, és van-e lift?",
        hint: "Mindent mi hordunk le; lift nélkül emeletenként 10% a felár.",
        options: (sel) => HOUSE_LIKE.includes(sel.projectType) ? ACCESS_HOUSE : ACCESS_FLAT,
        values: [...ACCESS_FLAT, ...ACCESS_HOUSE].map((o) => o.value),
    },
    hazard: {
        type: "number",
        unit: "m³",
        short: "Veszélyes hulladék",
        q: "Van-e veszélyes hulladék (festék, vegyszer, olaj, szigetelőanyag)?",
        hint: "Ezt nem keverjük a lommal, szabályosan adjuk le.",
        options: [opt("Nincs", "z0", { n: 0 }), opt("Kevés, néhány doboz (kb. 0,5 m³)", "z05", { n: 0.5 }), opt("Kb. 1 m³", "z1", { n: 1 }), opt("2 m³ vagy több", "z2", { n: 2 })],
    },

    // --- Takarítás, illegális hulladék: details for the call ---
    cleanType: {
        short: "Takarítás típusa",
        q: "Milyen takarításra van szükség?",
        options: [
            opt("Lakás vagy ház nagytakarítása", "nagy"), opt("Felújítás vagy festés utáni takarítás", "felujitas"),
            opt("Építés utáni takarítás", "epites"), opt("Iroda takarítása", "iroda"), opt("Üzem, csarnok, raktár takarítása", "csarnok"),
            opt("Egyéb", "egyeb"),
        ],
    },
    dumpPlace: {
        short: "Hol van",
        q: "Hol van a hulladék?",
        options: [opt("Saját telken, magánterületen", "magan"), opt("Közterületen, út mentén", "kozter"), opt("Külterületen, erdőben, földúton", "kulter")],
    },

    timeline: {
        short: "Kezdés",
        q: "Mikorra szeretné, hogy elkezdjük?",
        hint: "Legfeljebb 60 napon belül induló munkákat vállalunk.",
        options: [opt("Amint lehet", "asap"), opt("30 napon belül", "d30"), opt("60 napon belül", "d60")],
    },
};

export function fieldOrder(sel) {
    const pt = sel.projectType;
    if (!pt) return ["projectType"];
    if (sel.region === "tavol") return ["projectType", "region", "timeline"];
    if (pt === "takaritas") return ["projectType", "region", "cleanType", "size", "timeline"];
    if (pt === "illegalis") return ["projectType", "region", "volume", "dumpPlace", "timeline"];
    if (pt === "telek") return ["projectType", "region", "volume", "hazard", "timeline"];
    const access = [...FLAT_LIKE, ...HOUSE_LIKE].includes(pt) ? ["access"] : [];
    return ["projectType", "region", "size", "fullness", ...access, "hazard", "timeline"];
}

export function title(sel) {
    if (sel.projectType === "takaritas" && sel.cleanType) return labelOf("cleanType", sel);
    return labelOf("projectType", sel) || "Ingatlankiürítés";
}

// ---------------------------------------------------------------------------
//  QUOTE
// ---------------------------------------------------------------------------
// m³ of stuff: counted from the floor area, or asked directly for yards.
function volumeOf(sel) {
    if (sel.projectType === "telek") return numberOf(sel, "volume");
    const v = numberOf(sel, "size") * (P.fill[sel.fullness] ?? P.fill.normal);
    return Math.max(0.5, Math.round(v * 2) / 2);
}

// Why this job gets a call instead of a price, or null when it gets a price.
export function callReason(sel) {
    if (sel.region === "tavol") return "Távolabbi helyszínre a munka méretétől függően megyünk ki - ezt kollégánk telefonon egyezteti Önnel.";
    if (sel.projectType === "takaritas") return "A takarítás ára sok mindentől függ (szennyezettség, felületek, ablakok), ezért ezt kollégánk egyedileg árazza.";
    if (sel.projectType === "illegalis") return "Az illegálisan lerakott hulladék elszállítása helyszínenként nagyon eltér, ezért ezt kollégánk egyedileg árazza.";
    const m3 = volumeOf(sel);
    if (m3 > P.customAboveM3) return `Ekkora mennyiségnél (kb. ${num(m3)} m³) egyedi ajánlatot adunk.`;
    return null;
}

// Róbert's own rates applied to the answers, for the owner's call only.
export function ownerNotes(sel) {
    const notes = [];
    if (NO_PRICE.includes(sel.projectType) || sel.region === "tavol") {
        if (sel.volume) notes.push(`Megadott mennyiség: kb. ${num(numberOf(sel, "volume"))} m³.`);
        return notes;
    }
    const m3 = volumeOf(sel);
    const rate = P.perM3[sel.region] ?? P.perM3.kornyek;
    notes.push(`Kb. ${num(m3)} m³ × ${ft(rate)} = ${ft(m3 * rate)} + ÁFA (emelet és veszélyes hulladék nélkül).`);
    return notes;
}

const REGION_TEXT = "Budapesten, Pest megyében és a környező megyékben dolgozunk; nagyobb munkára távolabb is kimegyünk.";

export function buildQuote(sel, { money }) {
    const region = sel.region || "bp";
    const rate = P.perM3[region];
    const min = P.minM3[region];
    const yard = sel.projectType === "telek";
    const m3 = volumeOf(sel);
    const billed = Math.max(m3, min);
    const floors = (optionOf("access", sel) || {}).floors || (sel.projectType === "pince" ? 1 : 0);
    const hazard = numberOf(sel, "hazard");

    const base = billed * rate;
    const items = [{
        label: `${yard ? "Összegyűjtés, rakodás" : "Pakolás, kihordás, rakodás"}, elszállítás és lerakói díj (${billed > m3 ? `minimum ${num(billed)} m³` : `kb. ${num(billed)} m³`})`,
        amount: base,
    }];
    if (floors) items.push({ label: `Lift nélküli kihordás (${floors} emelet × 10%)`, amount: base * P.perFloorNoLift * floors });
    if (hazard) items.push({ label: `Veszélyes hulladék szabályos leadása (kb. ${num(hazard)} m³)`, amount: hazard * P.hazardPerM3 });

    const ex = [];
    if (yard) ex.push(`A becslés **kb. ${num(m3)} m³** hulladékkal számol${sel.volume === "nem_tudom" ? " (nem tudta pontosan)" : ""}.`);
    else ex.push(`A becslés **kb. ${num(m3)} m³** lommal számol (${num(numberOf(sel, "size"))} m², „${labelOf("fullness", sel).toLowerCase()}”).`);
    ex.push(`Ha a helyszínen több van, a különbözet köbméterenként ${money(rate)}${floors ? " (+ az emeleti felár)" : ""}.`);
    if (billed > m3) ex.push(`Ezen a helyszínen a legkisebb elszállított mennyiség ${num(min)} m³.`);
    if (!hazard) ex.push(`Veszélyes hulladék (festék, vegyszer, olaj, szigetelés), ha mégis van: ${money(P.hazardPerM3)}/m³.`);
    ex.push("Pala, azbeszt: engedélyhez kötött, külön eljárásban szállítjuk el, egyedi áron.");
    ex.push("Takarítás a kiürítés után, ha kéri: egyedi ár.");
    ex.push(REGION_TEXT);

    return {
        title: title(sel),
        items,
        includes: yard
            ? "a hulladék összegyűjtését, rakodását, elszállítását és a lerakói díjat tartalmazza"
            : "a pakolást, a zsákolást, a bútorok és gépek kihordását, a rakodást, az elszállítást, a lerakói díjat és a seprűtiszta átadást tartalmazza",
        exclusions: ex,
        flags: [],
    };
}

// ---------------------------------------------------------------------------
//  SANITY SCENARIOS - test-flow.mjs clicks these through. min/max are the exact
//  expected total (gross for private customers, net for companies), worked out
//  by hand from Róbert's rates. The engine adds 27% VAT and rounds each line to
//  1 000 Ft, so the comments show both steps.
// ---------------------------------------------------------------------------
export const TEST_SCENARIOS = [
    {
        // 40 m² / 2 = 20 m³ × 9 900 = 198 000 → 251 000; 2 floors × 10% = 39 600 → 50 000
        name: "Budapesti lakás 40–70 m², normál, 2. emelet lift nélkül",
        answers: { projectType: "Lakás kiürítése", region: "Budapest", size: "40–70 m²", fullness: "Normál berendezés", access: "2. emelet, lift nélkül", hazard: "Nincs", timeline: "30 napon belül" },
        min: 301000, max: 301000,
    },
    {
        // 6 m² × 0,5 = 3 m³ < 5 m³ minimum: 5 × 10 900 = 54 500 → 69 000; cellar stairs +10% = 5 450 → 7 000
        name: "Pest megyei pince 10 m² alatt (minimum mennyiség)",
        answers: { projectType: "Pince vagy padlás", region: "Pest megye", size: "10 m² alatt", fullness: "Normál berendezés", hazard: "Nincs", timeline: "60 napon belül" },
        min: 76000, max: 76000,
    },
    {
        // 120 m² × 0,75 = 90 m³ × 9 900 = 891 000 → 1 132 000; upstairs +10% = 89 100 → 113 000; 1 m³ hazard 29 900 → 38 000
        name: "Budapesti családi ház 120–200 m², zsúfolt, emeletről is, 1 m³ veszélyes",
        answers: { projectType: "Családi ház kiürítése", region: "Budapest", size: "120–200 m²", fullness: "Zsúfolt, sok holmi", access: "Az emeletről vagy a tetőtérből is", hazard: "Kb. 1 m³", timeline: "Amint lehet" },
        min: 1283000, max: 1283000,
    },
    {
        // typed 300 m² × 0,5 = 150 m³ > 100 → call
        name: "Csarnok 300 m² felett, normál (egyedi ajánlat)",
        answers: { projectType: "Raktár, üzem, csarnok", region: "Budapest", size: "300 m² felett", fullness: "Normál berendezés", hazard: "Nincs", timeline: "30 napon belül" },
        customer: "Cég",
        call: true,
    },
    {
        name: "Takarítás (egyedi ajánlat)",
        answers: { projectType: "Takarítás", region: "Budapest", cleanType: "Építés utáni takarítás", size: "50–100 m²", timeline: "Amint lehet" },
        call: true,
    },
];

// ---------------------------------------------------------------------------
//  WHAT THE AI MAY SAY ABOUT THE COMPANY (from the Banacraft kiürítés site)
// ---------------------------------------------------------------------------
export const KNOWLEDGE = `- Teljes körű ingatlankiürítés a pincétől a padlásig: lakás, családi ház, nyaraló, hagyatéki ingatlan, pince, padlás, garázs, műhely, iroda, üzlet, raktár, telek és udvar. Akár egyetlen nagyméretű bútor elvitelét is vállaljuk.
- Illegálisan lerakott hulladék összegyűjtése és elszállítása; ezt helyszínenként egyedileg árazzuk.
- Takarítás: lakás és ház nagytakarítása, felújítás, festés és építés utáni takarítás, irodák, üzemek, csarnokok, raktárak takarítása; ezt egyedileg árazzuk.
- Egy kézből a felméréstől az átadásig: pakolás, zsákolás, a mozgatáshoz szükséges bútorszétszerelés, lehordás emeletről lift nélkül is, rakodás, elszállítás akár több autóval, a hulladék engedéllyel, jogszabály szerinti lerakóba kerül.
- Az ügyfélnek nem kell pakolnia, cipelnie, konténert vagy fuvarost szerveznie, válogatnia, lerakóba járnia - csak megmutatja az ingatlant.
- Amit elszállítunk: bútorok (szekrény, ágy, kanapé, asztal), háztartási gépek (mosógép, hűtő, tűzhely), lom, dobozok, ruhák, könyvek, szőnyegek, matracok, szerszámok, kerti bútorok.
- Külön kezeljük és nem keverjük a lommal: veszélyes hulladék, vegyszerek, festékek, oldószerek, szigetelőanyag, azbeszttartalmú anyagok.
- Az alap seprűtiszta, rendezett átadás minden munka része; alaposabb takarítást előre egyeztetünk.
- Hagyatéki kiürítés tapintattal, diszkréten. Ha az ügyfél külföldön él vagy nem tud jelen lenni, a kulcsot átvehetjük (pl. a szomszédtól), és videón megküldjük a végeredményt.
- Előzetes ár fotó vagy videó alapján is kérhető; a fotókat az ${BOT.email} címre lehet küldeni. A végleges, fix árat előre adjuk, utólagos meglepetés nélkül. A felmérés díjmentes.
- Non-stop elérhetőek vagyunk, a hét minden napján; általában néhány órán belül válaszolunk.
- Budapesten, Pest megyében és a környező megyékben dolgozunk; nagyobb munkára az ország távolabbi részére is kimegyünk.
- Számlát adunk, felelősségbiztosítással dolgozunk, a munkára garanciát vállalunk.`;
