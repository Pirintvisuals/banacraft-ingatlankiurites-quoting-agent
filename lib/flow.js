// ============================================================================
//  BANACRAFT - INGATLANKIÜRÍTÉS, LOMTALANÍTÁS ÉS TAKARÍTÁS
//
//  Everything this bot knows about its trade: the questions (in order), their
//  buttons, the price model, and the facts the AI may repeat. The shared engine
//  in api/faq-agent.js reads only what is exported here.
//
//  PRICING PRINCIPLE - a floor, never a range. Every band answer ("40–70 m²")
//  is priced at its LOWER edge and "Nem tudom" at a modest default, so the
//  number the customer sees can only go UP at the survey - and the assumption
//  behind it is printed next to it. All amounts are NET Ft; the engine adds VAT
//  for private customers.
//
//  THE RATES ARE MARKET-CALIBRATED STARTING POINTS, NOT BANACRAFT'S OWN PRICE
//  LIST (2026 Budapest lomtalanítás / kiürítés / takarítás ranges). Replace the
//  numbers in `P` with Banacraft's real rates as soon as they are known; nothing
//  else needs to change.
// ============================================================================

export const BOT = {
    id: "banacraft-kiurites",
    service: "ingatlankiürítés, lomtalanítás és takarítás",
    phone: "+36 70 625 2014",
    email: "info@banacraft.hu",
};

// ---------------------------------------------------------------------------
//  PRICES (net Ft) - edit here only
// ---------------------------------------------------------------------------
const P = {
    // Clear-out, all-in per m³ of stuff: packing, carrying, loading, transport
    // and the landfill fee. Bigger loads get a lower rate.
    perM3: [[40, 16000], [100, 14500], [Infinity, 13000]],
    // Share of the per-m³ rate that is hand labour (carrying) - the only part
    // that stairs and a long walk to the truck make more expensive.
    labourShare: 0.45,
    // m³ of stuff per m² of floor, by how full the place is.
    fill: { ures: 0.08, normal: 0.3, zsufolt: 0.55, tele: 0.9 },
    // ...and per m² of yard, which is mostly empty ground.
    fillYard: { ures: 0.02, normal: 0.06, zsufolt: 0.12, tele: 0.25 },
    access: { fsz: 1, l13: 1.08, n13: 1.22, l4: 1.12, n4: 1.38, h_em: 1.18, h_pince: 1.15 },
    cellar: 1.15, // a pince/padlás job is always stairs
    distance: { d0: 1, d50: 1.1, dfar: 1.2, nem_tudom: 1 },
    dismantle: 35000, // built-in wardrobe / kitchen units, per job
    cleaning: { alap: 450, nagy: 900 }, // Ft / m², after the clear-out
    minJob: 45000,
    // Separately handled waste. One unit of each ticked kind goes into the
    // floor price; further units are named in the exclusions.
    special: {
        huto: { name: "Hűtő, fagyasztó vagy klíma elszállítása", unit: "1 db", per: "darabonként", price: 9000 },
        vegyszer: { name: "Festék, vegyszer, olaj szakszerű leadása", unit: "1 tétel", per: "tételenként", price: 15000 },
        gumi: { name: "Gumiabroncsok leadása", unit: "1 garnitúra", per: "garnitúránként", price: 10000 },
        elektro: { name: "Elektronikai hulladék leadása", unit: "1 db", per: "darabonként", price: 4000 },
        tormelek: { name: "Építési törmelék elszállítása", unit: "1 m³", per: "köbméterenként", price: 22000 },
        zold: { name: "Zöldhulladék elszállítása", unit: "1 m³", per: "köbméterenként", price: 12000 },
    },
    // Illegally dumped waste: picked up by hand from the ground, sorted.
    dump: {
        m3: { u: 1.5, k: 3, n: 8, t: 20, nem_tudom: 3 },
        perM3: 19000,
        heavy: 1.25, // building rubble
        access: { ok: 1, d50: 1.2, nehez: 1.35 },
        minJob: 60000,
    },
    // Cleaning, Ft / m² of floor.
    clean: {
        rate: { nagy: 700, felujitas: 1000, festes: 850, epites: 1200, iroda: 600, csarnok: 450, egyeb: 700 },
        dirt: { enyhe: 1, kozepes: 1.25, eros: 1.6 },
        height: { h3: 1, h6: 1.2, h9: 1.5 },
        windows: { w0: 0, w5: 1, w15: 6, w30: 15, wglass: 0 }, // counted at the band's lower edge
        window: 3500, // Ft / window, both sides
        glass: 40000, // shopfront / glass wall, from
        minJob: 35000,
    },
};

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
const opt = (label, value, extra) => ({ label, value, ...extra });
const NT = (extra) => opt("Nem tudom", "nem_tudom", extra);
const list = (sel, field) => String(sel[field] || "").split(",").filter(Boolean);
const num = (n) => String(Math.round(n * 10) / 10).replace(".", ",");

function optionOf(field, sel) {
    const f = FIELDS[field];
    const opts = typeof f.options === "function" ? f.options(sel) : f.options;
    return opts.find((o) => o.value === sel[field]) || null;
}
const labelOf = (field, sel) => (optionOf(field, sel) || {}).label || "";

// Floor area for pricing: a band chip is its lower edge, "Nem tudom" its default,
// a typed number itself.
function areaOf(sel, field = "size") {
    const o = optionOf(field, sel);
    if (o && o.area != null) return o.area;
    const n = parseFloat(String(sel[field] || "").replace(",", "."));
    return n > 0 ? n : 0;
}

// Top a small job up to the minimum charge, as its own visible line.
function topUp(items, min) {
    const sum = items.reduce((s, i) => s + i.amount, 0);
    if (sum < min) items.push({ label: "Kiegészítés a minimális díjig (kiszállás, munkadíj)", amount: min - sum });
    return items;
}

// ---------------------------------------------------------------------------
//  QUESTIONS
// ---------------------------------------------------------------------------
const CLEAROUT = ["lakas", "haz", "nyaralo", "hagyatek", "pince", "garazs", "iroda", "csarnok", "egyeb"];
const HOUSE_LIKE = ["haz", "nyaralo"];

const AREA = {
    flat: [opt("40 m² alatt", "f_lt40", { area: 30 }), opt("40–70 m²", "f_40_70", { area: 40 }), opt("70–120 m²", "f_70_120", { area: 70 }), opt("120 m² felett", "f_gt120", { area: 120 }), NT({ area: 45 })],
    house: [opt("80 m² alatt", "h_lt80", { area: 60 }), opt("80–120 m²", "h_80_120", { area: 80 }), opt("120–200 m²", "h_120_200", { area: 120 }), opt("200 m² felett", "h_gt200", { area: 200 }), NT({ area: 90 })],
    small: [opt("10 m² alatt", "s_lt10", { area: 6 }), opt("10–20 m²", "s_10_20", { area: 10 }), opt("20–40 m²", "s_20_40", { area: 20 }), opt("40 m² felett", "s_gt40", { area: 40 }), NT({ area: 12 })],
    hall: [opt("100 m² alatt", "c_lt100", { area: 70 }), opt("100–300 m²", "c_100_300", { area: 100 }), opt("300–600 m²", "c_300_600", { area: 300 }), opt("600 m² felett", "c_gt600", { area: 600 }), NT({ area: 150 })],
    yard: [opt("100 m² alatt", "y_lt100", { area: 60 }), opt("100–300 m²", "y_100_300", { area: 100 }), opt("300–1000 m²", "y_300_1000", { area: 300 }), opt("1000 m² felett", "y_gt1000", { area: 1000 }), NT({ area: 150 })],
    clean: [opt("50 m² alatt", "k_lt50", { area: 35 }), opt("50–100 m²", "k_50_100", { area: 50 }), opt("100–200 m²", "k_100_200", { area: 100 }), opt("200–500 m²", "k_200_500", { area: 200 }), opt("500 m² felett", "k_gt500", { area: 500 }), NT({ area: 60 })],
};
function areaGroup(sel) {
    const pt = sel.projectType;
    if (pt === "takaritas") return "clean";
    if (pt === "telek") return "yard";
    if (HOUSE_LIKE.includes(pt)) return "house";
    if (pt === "pince" || pt === "garazs") return "small";
    if (pt === "csarnok") return "hall";
    return "flat";
}

const TIMELINE = {
    short: "Kezdés",
    q: "Mikorra szeretné, hogy elkezdjük?",
    hint: "Legfeljebb 3 hónapon belül induló munkákat vállalunk.",
    options: [opt("Amint lehet", "asap"), opt("30 napon belül", "d30"), opt("60 napon belül", "d60"), opt("90 napon belül", "d90")],
};

const ACCESS_FLAT = [opt("Földszinten", "fsz"), opt("1–3. emelet, lifttel", "l13"), opt("1–3. emelet, lift nélkül", "n13"), opt("4. emelet vagy feljebb, lifttel", "l4"), opt("4. emelet vagy feljebb, lift nélkül", "n4")];
const ACCESS_HOUSE = [opt("Csak a földszinten", "fsz"), opt("Az emeletről vagy a tetőtérből is", "h_em"), opt("A pincéből is", "h_pince")];

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

    // --- Takarítás ---
    cleanType: {
        short: "Takarítás típusa",
        q: "Milyen takarításra van szükség?",
        options: [
            opt("Lakás vagy ház nagytakarítása", "nagy"), opt("Felújítás utáni takarítás", "felujitas"), opt("Festés utáni takarítás", "festes"),
            opt("Építés utáni takarítás", "epites"), opt("Iroda takarítása", "iroda"), opt("Üzem, csarnok, raktár takarítása", "csarnok"),
            opt("Egyéb épület takarítása", "egyeb"),
        ],
    },

    size: {
        type: "area",
        short: "Alapterület",
        q: (sel) => sel.projectType === "telek" ? "Mekkora a telek vagy az udvar érintett része?"
            : sel.projectType === "takaritas" ? "Mekkora a takarítandó terület?"
            : "Mekkora az alapterület?",
        hint: "Elég nagyjából - konkrét számot is írhat.",
        options: (sel) => AREA[areaGroup(sel)],
        values: [...new Set(Object.values(AREA).flat().map((o) => o.value))],
    },

    fullness: {
        short: "Telítettség",
        q: (sel) => sel.projectType === "telek" ? "Mennyi lom van az udvaron?" : "Mennyire van tele?",
        hint: (sel) => sel.projectType === "telek" ? null : "Ez számít a legtöbbet: ebből tudjuk, hány köbméter lomot kell elvinni.",
        options: (sel) => sel.projectType === "telek"
            ? [opt("Néhány darab", "ures"), opt("Több kupac", "normal"), opt("Nagy része tele van", "zsufolt"), opt("Teljesen tele van", "tele")]
            : [opt("Szinte üres, csak néhány darab", "ures"), opt("Normál berendezés", "normal"), opt("Zsúfolt, sok holmi", "zsufolt"), opt("Padlótól plafonig tele", "tele")],
        values: ["ures", "normal", "zsufolt", "tele"],
    },

    access: {
        short: "Emelet / szint",
        q: (sel) => HOUSE_LIKE.includes(sel.projectType) ? "Honnan kell kihordani?" : "Hányadik emeleten van, és van-e lift?",
        hint: "Mindent mi hordunk le, a lépcső csak a munkaidőt befolyásolja.",
        options: (sel) => HOUSE_LIKE.includes(sel.projectType) ? ACCESS_HOUSE : ACCESS_FLAT,
        values: [...new Set([...ACCESS_FLAT, ...ACCESS_HOUSE].map((o) => o.value))],
    },

    distance: {
        short: "Teherautó távolsága",
        q: "Milyen közel tud megállni a teherautó a bejárathoz?",
        options: [opt("Közvetlenül a bejáratnál", "d0"), opt("20–50 méterre", "d50"), opt("50 méternél messzebb", "dfar"), NT()],
    },

    special: {
        type: "multi",
        short: "Külön kezelendő",
        q: "Van-e ezek közül bármi?",
        hint: "Ezeket nem keverjük a normál lommal, szabályosan adjuk le őket.",
        options: [
            opt("Hűtő, fagyasztó, klíma", "huto"), opt("Festék, vegyszer, olaj", "vegyszer"), opt("Gumiabroncs", "gumi"),
            opt("Elektronika, TV, monitor", "elektro"), opt("Építési törmelék", "tormelek"), opt("Zöldhulladék, ág, gally", "zold"),
            opt("Pala, azbeszt", "azbeszt"), opt("Nincs ilyen", "nincs"),
        ],
        none: ["nincs"],
        after: (sel) => list(sel, "special").includes("azbeszt")
            ? "A palát és az azbesztet engedéllyel, külön eljárásban szállítjuk el - ezt a felmérés után külön árazzuk."
            : null,
    },

    dismantle: {
        short: "Bútorszétszerelés",
        q: "Kell-e bútort szétszerelni?",
        options: [opt("Nem, minden mozdítható", "nem"), opt("Igen, beépített szekrény vagy konyhabútor is van", "igen"), NT()],
    },

    cleaning: {
        short: "Takarítás utána",
        q: "Kér takarítást a kiürítés után?",
        hint: "A seprűtiszta, rendezett átadás minden munkánk része.",
        options: [opt("Nem, elég a seprűtiszta átadás", "nem"), opt("Alaptakarítás", "alap"), opt("Nagytakarítás, átadásra kész állapot", "nagy")],
    },

    // --- Illegálisan lerakott hulladék ---
    dumpSize: {
        short: "Hulladék mennyisége",
        q: "Körülbelül mekkora a lerakott hulladék?",
        options: [
            opt("Egy utánfutónyi (1–2 m³)", "u"), opt("Egy kisteherautónyi (3–6 m³)", "k"),
            opt("Egy nagy teherautónyi (8–15 m³)", "n"), opt("Több teherautónyi (20 m³ felett)", "t"), NT(),
        ],
    },
    dumpContent: {
        type: "multi",
        short: "Mi van benne",
        q: "Mi van a lerakott hulladékban?",
        options: [
            opt("Háztartási szemét, lom", "haztartasi"), opt("Építési törmelék", "tormelek"), opt("Gumiabroncs", "gumi"),
            opt("Zöldhulladék", "zold"), opt("Pala, azbeszt", "azbeszt"), opt("Vegyes, nem tudom", "vegyes"),
        ],
    },
    dumpPlace: {
        short: "Hol van",
        q: "Hol van a hulladék?",
        options: [opt("Saját telken, magánterületen", "magan"), opt("Közterületen, út mentén", "kozter"), opt("Külterületen, erdőben, földúton", "kulter")],
    },
    dumpAccess: {
        short: "Megközelítés",
        q: "Oda tud állni a teherautó?",
        options: [opt("Igen, közvetlenül mellé", "ok"), opt("20–50 méter hordással", "d50"), opt("Nehezen megközelíthető", "nehez")],
    },

    // --- Takarítás, folytatás ---
    dirt: {
        short: "Szennyezettség",
        q: "Mennyire szennyezett?",
        options: [opt("Enyhén (normál por, kosz)", "enyhe"), opt("Közepesen (vastagabb por, néhány folt)", "kozepes"), opt("Erősen (festék-, vakolat-, ragasztófoltok)", "eros")],
    },
    windows: {
        short: "Ablaktisztítás",
        q: "Kér ablaktisztítást is?",
        options: [opt("Nem kérek", "w0"), opt("1–5 ablak", "w5"), opt("6–15 ablak", "w15"), opt("15-nél több ablak", "w30"), opt("Nagy üvegfelületek, kirakat", "wglass")],
    },
    height: {
        short: "Belmagasság",
        q: "Milyen magas a belmagasság?",
        options: [opt("Normál, 3 méterig", "h3"), opt("3–6 méter", "h6"), opt("6 méter felett", "h9")],
    },

    timeline: TIMELINE,
};

export function fieldOrder(sel) {
    const pt = sel.projectType;
    if (!pt) return ["projectType"];
    if (pt === "takaritas") {
        return ["projectType", "cleanType", "size", "dirt", "windows",
            ...(["csarnok", "egyeb"].includes(sel.cleanType) ? ["height"] : []), "timeline"];
    }
    if (pt === "illegalis") return ["projectType", "dumpSize", "dumpContent", "dumpPlace", "dumpAccess", "timeline"];
    if (pt === "telek") return ["projectType", "size", "fullness", "distance", "special", "timeline"];
    const access = ["pince", "garazs", "csarnok"].includes(pt) ? [] : ["access"];
    return ["projectType", "size", "fullness", ...access, "distance", "special", "dismantle", "cleaning", "timeline"];
}

export function title(sel) {
    if (sel.projectType === "takaritas" && sel.cleanType) return labelOf("cleanType", sel);
    return labelOf("projectType", sel) || "Ingatlankiürítés";
}

// ---------------------------------------------------------------------------
//  QUOTE - returns net amounts; the engine applies VAT and rounding
// ---------------------------------------------------------------------------
const AREA_REGION = "Budapesten, valamint Pest, Fejér és Nógrád vármegyében dolgozunk; Budapesten kívül kiszállási díj lehet.";

export function buildQuote(sel, { money }) {
    if (sel.projectType === "takaritas") return quoteCleaning(sel, money);
    if (sel.projectType === "illegalis") return quoteDump(sel, money);
    return quoteClearout(sel, money);
}

function quoteClearout(sel, money) {
    const yard = sel.projectType === "telek";
    const A = areaOf(sel);
    const fill = (yard ? P.fillYard : P.fill)[sel.fullness] ?? P.fill.normal;
    const m3 = Math.max(1, Math.round(A * fill * 2) / 2);
    const rate = P.perM3.find(([max]) => m3 <= max)[1];
    const accessK = sel.projectType === "pince" ? P.cellar : (P.access[sel.access] ?? 1);
    const distK = P.distance[sel.distance] ?? 1;
    const special = list(sel, "special");

    const items = [
        { label: yard ? "Összegyűjtés, rakodás" : "Pakolás, zsákolás, kihordás és rakodás", amount: m3 * rate * P.labourShare * accessK * distK },
        { label: `Elszállítás és lerakói díj (kb. ${num(m3)} m³)`, amount: m3 * rate * (1 - P.labourShare) },
    ];
    if (sel.dismantle === "igen") items.push({ label: "Beépített bútorok szétszerelése", amount: P.dismantle });
    for (const s of special) {
        const sp = P.special[s];
        if (sp) items.push({ label: `${sp.name} (${sp.unit})`, amount: sp.price });
    }
    if (P.cleaning[sel.cleaning]) {
        items.push({ label: `${sel.cleaning === "nagy" ? "Nagytakarítás" : "Alaptakarítás"} (kb. ${num(A)} m²)`, amount: A * P.cleaning[sel.cleaning] });
    }
    topUp(items, P.minJob);

    const ex = [];
    const areaNote = sel.size === "nem_tudom" ? `kb. ${num(A)} m²-rel számolva` : `${num(A)} m²`;
    ex.push(`A becslés **kb. ${num(m3)} m³** lommal számol (${areaNote}, „${labelOf("fullness", sel).toLowerCase()}”). Ha a helyszínen több van, a különbözet köbméterenként ${money(rate)}.`);
    for (const s of special) {
        const sp = P.special[s];
        if (sp) ex.push(`${sp.name}: további ${sp.per} ${money(sp.price)}.`);
    }
    if (!special.length || special.includes("nincs")) ex.push("Veszélyes hulladék (hűtő, festék, gumi, elektronika) tételenként külön díjjal.");
    if (sel.distance === "nem_tudom") ex.push("Ha a teherautó 20 méternél messzebb áll meg, hordási felár.");
    if (sel.dismantle === "nem_tudom") ex.push(`Beépített bútor szétszerelése: ${money(P.dismantle)}-tól.`);
    if (!yard && sel.cleaning === "nem") ex.push(`Takarítás, ha mégis kéri: alaptakarítás ${money(P.cleaning.alap)}/m²-től.`);
    ex.push(AREA_REGION);

    const flags = [];
    if (special.includes("azbeszt")) flags.push("A pala és az azbeszt engedélyköteles, külön eljárásban kerül elszállításra - ezt a felmérés után külön árazzuk.");

    return {
        title: title(sel),
        items,
        includes: yard
            ? "a lom összegyűjtését, rakodását, elszállítását és a lerakói díjat tartalmazza, rendezett udvarral"
            : "a pakolást, a zsákolást, a bútorok és gépek kihordását, a rakodást, az elszállítást, a lerakói díjat és a seprűtiszta átadást tartalmazza",
        exclusions: ex,
        flags,
    };
}

function quoteDump(sel, money) {
    const D = P.dump;
    const m3 = D.m3[sel.dumpSize] ?? D.m3.nem_tudom;
    const content = list(sel, "dumpContent");
    const heavy = content.includes("tormelek") ? D.heavy : 1;
    const accK = D.access[sel.dumpAccess] ?? 1;

    const items = [
        { label: "Kézi összegyűjtés, válogatás és rakodás", amount: m3 * D.perM3 * 0.5 * heavy * accK },
        { label: `Elszállítás és lerakói díj (kb. ${num(m3)} m³)`, amount: m3 * D.perM3 * 0.5 * heavy },
    ];
    topUp(items, D.minJob);

    const ex = [`A becslés **kb. ${num(m3)} m³** hulladékkal számol${sel.dumpSize === "nem_tudom" ? " (nem tudta pontosan)" : ""}; több hulladéknál köbméterenként ${money(D.perM3 * heavy)}.`];
    if (content.includes("gumi")) ex.push(`Gumiabroncs: ${money(2500)}/db.`);
    if (content.includes("vegyes") || content.includes("haztartasi")) ex.push("Veszélyes összetevők (vegyszer, olaj, elektronika) tételenként külön.");
    if (sel.dumpPlace === "kozter") ex.push("Közterületen a terület tulajdonosának (pl. az önkormányzatnak) a hozzájárulása szükséges lehet.");
    if (sel.dumpPlace === "kulter") ex.push("Földúton, erdőben a megközelíthetőségtől függően felár lehet.");
    ex.push(AREA_REGION);

    const flags = [];
    if (content.includes("azbeszt")) flags.push("A pala és az azbeszt engedélyköteles, külön eljárásban kerül elszállításra - ezt a felmérés után külön árazzuk.");

    return {
        title: "Illegálisan lerakott hulladék elszállítása",
        items,
        includes: "a hulladék kézi összegyűjtését, válogatását, rakodását, elszállítását, a lerakói díjat és a rendezett terület átadását tartalmazza",
        exclusions: ex,
        flags,
    };
}

function quoteCleaning(sel, money) {
    const C = P.clean;
    const A = areaOf(sel);
    const rate = C.rate[sel.cleanType] ?? C.rate.egyeb;
    const dirt = C.dirt[sel.dirt] ?? 1;
    const h = C.height[sel.height] ?? 1;

    const items = [{ label: `${labelOf("cleanType", sel)} (kb. ${num(A)} m²)`, amount: A * rate * dirt * h }];
    const n = C.windows[sel.windows] ?? 0;
    if (n) items.push({ label: `Ablaktisztítás kívül-belül (${n} ablak)`, amount: n * C.window });
    if (sel.windows === "wglass") items.push({ label: "Nagy üvegfelületek tisztítása", amount: C.glass });
    topUp(items, C.minJob);

    const ex = [`A becslés **${num(A)} m²** területtel számol${sel.size === "nem_tudom" ? " (nem tudta pontosan)" : ""}; nagyobb területnél arányosan több (${money(rate * dirt * h)}/m²).`];
    if (n) ex.push(`További ablakok: ${money(C.window)}/db.`);
    if (sel.windows === "wglass") ex.push("Az üvegfelületek díja a tényleges felület szerint.");
    if (sel.dirt === "eros") ex.push("Beszáradt festék, ragasztó, cementfátyol eltávolítása a felmérés szerint, egyedi árazással.");
    if (sel.height === "h9") ex.push("6 méter feletti magasságban emelőgép bérleti díja külön.");
    ex.push(AREA_REGION);

    return {
        title: title(sel),
        items,
        includes: "a takarítás munkadíját, a gépeket és a tisztítószereket tartalmazza",
        exclusions: ex,
        flags: [],
    };
}

// ---------------------------------------------------------------------------
//  SANITY SCENARIOS - test-flow.mjs clicks these through and prints the price.
//  min/max are loose market envelopes (gross Ft for private customers), there
//  to catch a rate edit that drifts off by an order of magnitude.
// ---------------------------------------------------------------------------
export const TEST_SCENARIOS = [
    {
        name: "Lakás 40–70 m², normál, 3. emelet lifttel",
        answers: { projectType: "Lakás kiürítése", size: "40–70 m²", fullness: "Normál berendezés", access: "1–3. emelet, lifttel", distance: "Közvetlenül a bejáratnál", special: "Nincs ilyen", dismantle: "Nem, minden mozdítható", cleaning: "Nem, elég a seprűtiszta átadás", timeline: "30 napon belül" },
        min: 150000, max: 500000,
    },
    {
        name: "Hagyatéki lakás 120 m² felett, zsúfolt, 4. emelet lift nélkül, hűtő + festék, nagytakarítás",
        answers: { projectType: "Hagyatéki ingatlan kiürítése", size: "120 m² felett", fullness: "Zsúfolt, sok holmi", access: "4. emelet vagy feljebb, lift nélkül", distance: "20–50 méterre", special: ["Hűtő, fagyasztó, klíma", "Festék, vegyszer, olaj"], dismantle: "Igen, beépített szekrény vagy konyhabútor is van", cleaning: "Nagytakarítás, átadásra kész állapot", timeline: "Amint lehet" },
        min: 800000, max: 3000000,
    },
    {
        name: "Családi ház 120–200 m², padlótól plafonig, emeletről is",
        answers: { projectType: "Családi ház kiürítése", size: "120–200 m²", fullness: "Padlótól plafonig tele", access: "Az emeletről vagy a tetőtérből is", distance: "Közvetlenül a bejáratnál", special: "Nincs ilyen", dismantle: "Nem, minden mozdítható", cleaning: "Nem, elég a seprűtiszta átadás", timeline: "30 napon belül" },
        min: 1000000, max: 4000000,
    },
    {
        name: "Pince 10–20 m², normál",
        answers: { projectType: "Pince vagy padlás", size: "10–20 m²", fullness: "Normál berendezés", special: "Nincs ilyen", dismantle: "Nem, minden mozdítható", cleaning: "Nem, elég a seprűtiszta átadás", timeline: "60 napon belül" },
        min: 45000, max: 200000,
    },
    {
        name: "Illegális hulladék, kisteherautónyi építési törmelék, közterületen",
        answers: { projectType: "Illegálisan lerakott hulladék", dumpSize: "Egy kisteherautónyi (3–6 m³)", dumpContent: ["Építési törmelék"], dumpPlace: "Közterületen, út mentén", dumpAccess: "Igen, közvetlenül mellé", timeline: "30 napon belül" },
        min: 60000, max: 300000,
    },
    {
        name: "Építés utáni takarítás 100–200 m², erősen szennyezett, 6–15 ablak (cég, nettó)",
        answers: { projectType: "Takarítás", cleanType: "Építés utáni takarítás", size: "100–200 m²", dirt: "Erősen (festék-, vakolat-, ragasztófoltok)", windows: "6–15 ablak", timeline: "Amint lehet" },
        customer: "Cég",
        min: 120000, max: 600000,
    },
    {
        name: "Csarnok takarítása 500 m² felett, 6 m felett",
        answers: { projectType: "Takarítás", cleanType: "Üzem, csarnok, raktár takarítása", size: "500 m² felett", dirt: "Közepesen (vastagabb por, néhány folt)", windows: "Nem kérek", height: "6 méter felett", timeline: "90 napon belül" },
        customer: "Cég",
        min: 250000, max: 1500000,
    },
];

// ---------------------------------------------------------------------------
//  WHAT THE AI MAY SAY ABOUT THE COMPANY (from the Banacraft kiürítés site)
// ---------------------------------------------------------------------------
export const KNOWLEDGE = `- Teljes körű ingatlankiürítés a pincétől a padlásig: lakás, családi ház, nyaraló, hagyatéki ingatlan, pince, padlás, garázs, műhely, iroda, üzlet, raktár, telek és udvar. Akár egyetlen nagyméretű bútor elvitelét is vállaljuk.
- Illegálisan lerakott hulladék összegyűjtése és elszállítása.
- Takarítás: lakás és ház nagytakarítása, felújítás, festés és építés utáni takarítás, irodák, üzemek, csarnokok, raktárak és egyéb épületek takarítása.
- Egy kézből a felméréstől az átadásig: pakolás, zsákolás, a mozgatáshoz szükséges bútorszétszerelés, lehordás emeletről lift nélkül is, rakodás, elszállítás akár több autóval, a hulladék engedéllyel, jogszabály szerinti lerakóba kerül.
- Az ügyfélnek nem kell pakolnia, cipelnie, konténert vagy fuvarost szerveznie, válogatnia, lerakóba járnia - csak megmutatja az ingatlant.
- Amit elszállítunk: bútorok (szekrény, ágy, kanapé, asztal), háztartási gépek (mosógép, hűtő, tűzhely), lom, dobozok, ruhák, könyvek, szőnyegek, matracok, szerszámok, kerti bútorok.
- Külön kezeljük és nem keverjük a lommal: veszélyes hulladék, vegyszerek, egyes festékek, oldószerek, azbeszttartalmú anyagok. Ezekre előre szólunk, és megmondjuk a helyes kezelést.
- Az alap seprűtiszta, rendezett átadás minden munka része; alaposabb takarítást előre egyeztetünk.
- Hagyatéki kiürítés tapintattal, diszkréten. Ha az ügyfél külföldön él vagy nem tud jelen lenni, a kulcsot átvehetjük (pl. a szomszédtól), és videón megküldjük a végeredményt.
- Előzetes ár fotó vagy videó alapján is kérhető; a fotókat az ${BOT.email} címre lehet küldeni. A végleges, fix árat előre adjuk, a rakodási körülmények ismeretében, utólagos meglepetés nélkül. A felmérés díjmentes.
- Non-stop elérhetőek vagyunk, a hét minden napján; általában néhány órán belül válaszolunk.
- Működési terület: Budapest, valamint Pest, Fejér és Nógrád vármegye.
- Számlát adunk, felelősségbiztosítással dolgozunk, a munkára garanciát vállalunk.`;
