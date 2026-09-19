"use strict";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */
const SHEET_ID = "1fkvVtIrb2o47ludvFH-O7lcyEANrFIS4HXWFbPAagP8";

// One entry per center tab. "gid" is the number after #gid= in that tab's URL.
// TODO: Durgapuri and Head Office don't have a tab/gid yet — add them here once you have the link.
const CENTER_SHEETS = [
  { name: "Shahdara", gid: "274553614" },
  { name: "Tigri", gid: "1856402156" },
  { name: "Uttam Nagar", gid: "1805107180" },
  { name: "Keshav Puram", gid: "150450486" },
  { name: "Mayur Vihar", gid: "1101218141" },
];

const gvizUrl = (gid) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&gid=${gid}`;

// Fixed column layout shared by every center tab (0-indexed):
// A s.no | B training type | C training modules | D training date |
// E center name | F designation | G name | H training done | I training not done | J training mode
const COL = { TYPE: 1, MODULES: 2, DATES: 3, DESIGNATION: 5, NAME: 6, DONE: 7, NOTDONE: 8, MODE: 9 };

// soft palette on a light background
const PALETTE = ["#7fbfd8", "#a99fd4", "#dc9dc0", "#e0c07f", "#8fc9a1", "#e0a97e", "#84c4c0", "#d29a9a", "#b6a4d6", "#a6b2c6", "#93c7bc"];
const GRID = "rgba(43,54,72,0.10)";
const TICK = "#6b7688";
const LABEL = "#2b3648";

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */
let RECORDS = [];          // flattened: one row per matched training-done/not-done item
let sortKey = "date";
let sortDir = -1;          // -1 = desc
let peopleSortKey = "total";
let peopleSortDir = -1;    // -1 = desc
let timeChart;

// Consistent color per training type, used everywhere a type is shown
// (the type chart, the People table chips, the dot in the training log).
let TYPE_COLORS = new Map();
function buildTypeColors() {
  const types = [...new Set(RECORDS.map((r) => r.type))].filter(Boolean).sort();
  TYPE_COLORS = new Map(types.map((t, i) => [t, PALETTE[i % PALETTE.length]]));
}
function typeColor(t) {
  return TYPE_COLORS.get(t) || "#9aa5b8";
}

/* ------------------------------------------------------------------ */
/*  Fetch                                                              */
/* ------------------------------------------------------------------ */
async function fetchSheetRows(gid) {
  const res = await fetch(gvizUrl(gid), { cache: "no-store" });
  const text = await res.text();
  const json = JSON.parse(text.replace(/^[\s\S]*?setResponse\(/, "").replace(/\);?\s*$/, ""));
  return (json.table.rows || []).map((r) =>
    (r.c || []).map((cell) => (cell && cell.v != null ? String(cell.v) : ""))
  );
}

/* ------------------------------------------------------------------ */
/*  Parsing: turn one center's raw rows into a catalog + person list   */
/* ------------------------------------------------------------------ */
function stripNumbering(s) {
  return String(s || "").replace(/^\s*\d+\.\s*/, "").trim();
}
function splitLines(raw) {
  return String(raw || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
function parseDMY(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return isNaN(d) ? null : d;
}

// A "catalog row" is any row where the training-type column is filled in.
// It defines a training type plus its ordered modules and matching dates.
// A "person row" is any row where the name column is filled in.
function parseCenterSheet(rows, centerName) {
  const catalog = [];
  const persons = [];
  rows.forEach((r) => {
    const type = (r[COL.TYPE] || "").trim();
    const designation = (r[COL.DESIGNATION] || "").trim();
    const name = (r[COL.NAME] || "").trim();
    const mode = (r[COL.MODE] || "").trim();
    const doneRaw = r[COL.DONE] || "";
    const notdoneRaw = r[COL.NOTDONE] || "";

    if (type) {
      const modules = splitLines(r[COL.MODULES]).map(stripNumbering);
      const dates = splitLines(r[COL.DATES]);
      catalog.push({
        type,
        modules: modules.map((m, i) => ({ name: m, date: parseDMY(dates[i]) })),
      });
    }
    if (name) {
      persons.push({ center: centerName, designation, name, doneRaw, notdoneRaw, mode });
    }
  });
  return { catalog, persons };
}

/* ------------------------------------------------------------------ */
/*  Merge every center's catalog into one master catalog               */
/* ------------------------------------------------------------------ */
function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function titleCase(s) {
  return String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Levenshtein similarity ratio (0..1). Used to catch typos like "managar" vs
// "manager" without a hand-maintained list of every possible misspelling.
function similarity(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return 1 - dp[m][n] / Math.max(m, n);
}

/* ---- Designation canonicalization ---- */
// Known roles. If a raw value is close enough to one of these (typos like
// "managar"), it's remapped so it isn't counted as a separate role.
const DESIGNATION_DICTIONARY = [
  "Manager", "Reception", "Billing", "Pharmacy", "Lab Technician", "Counsellor",
  "Patient Coordinator", "Call Center", "Marketing", "Doctor", "Doctor Assistant",
  "Nurse", "Other",
];
const designationCache = new Map();
function canonicalizeDesignation(raw) {
  const key = normalize(raw);
  if (!key) return "";
  if (designationCache.has(key)) return designationCache.get(key);
  let best = null, bestScore = 0;
  DESIGNATION_DICTIONARY.forEach((d) => {
    const s = similarity(key, normalize(d));
    if (s > bestScore) { bestScore = s; best = d; }
  });
  const result = bestScore >= 0.72 ? best : titleCase(raw);
  designationCache.set(key, result);
  return result;
}

/* ---- Training mode canonicalization ---- */
// Keyword-based rather than edit-distance: "online" and "online training" are
// not a typo of each other, they're just different phrasings of the same thing.
function canonicalizeMode(raw) {
  const n = normalize(raw);
  if (!n) return "";
  if (n.includes("online")) return "Online";
  if (n.includes("hybrid")) return "Hybrid";
  if (n.includes("offline") || n.includes("in person") || n.includes("onsite") || n.includes("on site") || n.includes("physical")) return "Offline / In-person";
  if (n.includes("class")) return "Classroom";
  return titleCase(raw);
}

/* ---- Uncatalogued free-text label clustering ---- */
// Items in "training done"/"not done" that don't match any known type or
// module (e.g. a program that has no catalog row yet). Different centers may
// type the same program name slightly differently ("TB/DIABETES PROGRAMME"
// vs "TB DIABETES PROGRAM ") — cluster near-identical labels into one so they
// don't fragment into look-alike duplicate rows/categories.
function makeUncatalogueClusterer() {
  const seen = []; // [{ norm, canonical }]
  return function canonicalizeUncatalogued(label) {
    const n = normalize(label);
    if (!n) return label;
    for (const s of seen) {
      if (s.norm === n || similarity(s.norm, n) >= 0.85) return s.canonical;
    }
    const canonical = String(label).trim();
    seen.push({ norm: n, canonical });
    return canonical;
  };
}

function mergeCatalogs(perCenterCatalogs) {
  const byType = new Map(); // normalized type -> { type, modulesByKey: Map }
  perCenterCatalogs.forEach((catalog) => {
    catalog.forEach(({ type, modules }) => {
      const key = normalize(type);
      if (!key) return;
      if (!byType.has(key)) byType.set(key, { type, modulesByKey: new Map() });
      const entry = byType.get(key);
      modules.forEach((m) => {
        const mk = normalize(m.name);
        if (!mk) return;
        const existing = entry.modulesByKey.get(mk);
        if (!existing || (!existing.date && m.date)) entry.modulesByKey.set(mk, m);
      });
    });
  });
  const merged = [...byType.values()].map((e) => ({ type: e.type, modules: [...e.modulesByKey.values()] }));
  // longer/more specific type names are checked first when matching free text
  merged.sort((a, b) => normalize(b.type).length - normalize(a.type).length);
  return merged;
}

/* ------------------------------------------------------------------ */
/*  Match free-text "training done" / "training not done" cells        */
/*  against the master catalog using normalized substring matching.    */
/*  This copes with commas, newlines, no separator at all, and minor   */
/*  typos, as long as the core phrase matches what's typed elsewhere   */
/*  on the same sheet (see the parsing notes shared with the user).    */
/* ------------------------------------------------------------------ */
function matchField(raw, masterCatalog) {
  if (!raw) return [];
  const segments = String(raw).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const results = [];
  segments.forEach((seg) => {
    let work = normalize(seg);
    let consumed = false;
    const matchedTypes = new Set();

    // Pass 1: whole training-type matches (a segment can contain more than one,
    // e.g. "cps upgrade moduls training" with no separator between them).
    masterCatalog.forEach((t) => {
      const nt = normalize(t.type);
      if (nt && work.includes(nt)) {
        results.push({ kind: "type", type: t.type, modules: t.modules });
        work = work.split(nt).join(" ");
        consumed = true;
        matchedTypes.add(t.type);
      }
    });

    // Pass 2: individual module matches, for types not already fully matched above.
    masterCatalog.forEach((t) => {
      if (matchedTypes.has(t.type)) return;
      [...t.modules].sort((a, b) => normalize(b.name).length - normalize(a.name).length).forEach((m) => {
        const nm = normalize(m.name);
        if (nm && nm.length > 3 && work.includes(nm)) {
          results.push({ kind: "module", type: t.type, module: m });
          work = work.split(nm).join(" ");
          consumed = true;
        }
      });
    });

    // Nothing in the catalog matched this segment — keep it visible rather than
    // silently dropping it (e.g. a training program that has no catalog row yet).
    if (!consumed) results.push({ kind: "raw", label: seg });
  });
  return results;
}

// A training type is all-or-partial-complete, not "one row per mention":
// - If the whole type name is written in the done column, every module of
//   that type is Done (even ones never individually mentioned).
// - If the whole type name is written in the not-done column (and not also
//   fully done), every module is Not done.
// - If only some individual modules are named, those named ones take their
//   named status, and every OTHER module of that same type defaults to
//   Not done — naming a few modules means the rest are still pending, not
//   that they never happened.
function expandPersonType(type, masterCatalog, info, personBase, out) {
  const entry = masterCatalog.find((t) => t.type === type);
  const modules = entry ? entry.modules : [];
  if (!modules.length) {
    out.push({ ...personBase, type, topic: type, date: null, status: info.allDone ? "Done" : "Not done" });
    return;
  }
  modules.forEach((mod) => {
    // Explicitly done, or the whole type was marked done → Done.
    // Everything else (explicit not-done mention, or simply never
    // mentioned) defaults to Not done: naming only some modules means
    // the rest are still pending, not that they never happened.
    const status = info.allDone || info.doneSet.has(normalize(mod.name)) ? "Done" : "Not done";
    out.push({ ...personBase, type, topic: mod.name, date: mod.date, status });
  });
}

function buildPersonRecords(doneRaw, notdoneRaw, masterCatalog, personBase, canonicalizeUncatalogued) {
  const typeInfo = new Map();
  const infoFor = (t) => {
    if (!typeInfo.has(t)) typeInfo.set(t, { doneSet: new Set(), allDone: false });
    return typeInfo.get(t);
  };

  const out = [];

  matchField(doneRaw, masterCatalog).forEach((m) => {
    if (m.kind === "type") {
      if (m.modules.length) infoFor(m.type).allDone = true;
      else out.push({ ...personBase, type: m.type, topic: m.type, date: null, status: "Done" });
    } else if (m.kind === "module") {
      infoFor(m.type).doneSet.add(normalize(m.module.name));
    } else {
      out.push({ ...personBase, type: "Uncatalogued", topic: canonicalizeUncatalogued(m.label), date: null, status: "Done" });
    }
  });

  matchField(notdoneRaw, masterCatalog).forEach((m) => {
    if (m.kind === "type") {
      if (!m.modules.length) out.push({ ...personBase, type: m.type, topic: m.type, date: null, status: "Not done" });
      else infoFor(m.type); // ensure the type still expands even if never mentioned as done
    } else if (m.kind === "module") {
      infoFor(m.type); // named module already defaults to Not done unless it's in doneSet
    } else {
      out.push({ ...personBase, type: "Uncatalogued", topic: canonicalizeUncatalogued(m.label), date: null, status: "Not done" });
    }
  });

  typeInfo.forEach((info, type) => expandPersonType(type, masterCatalog, info, personBase, out));

  return out;
}

// One person's done+not-done matches can legitimately overlap (same module
// mentioned as both, due to messy data entry) or repeat (same item typed
// twice in one cell). Collapse to one record per (type, topic, date):
// an explicit "Not done" always wins over "Done" for the same item, and
// exact repeats are dropped so nothing is shown twice.
function dedupePersonRecords(records) {
  const byKey = new Map();
  records.forEach((r) => {
    const key = [r.type, r.topic, r.date ? r.date.getTime() : ""].join("|||");
    const existing = byKey.get(key);
    if (!existing || (existing.status === "Done" && r.status === "Not done")) {
      byKey.set(key, r);
    }
  });
  return [...byKey.values()];
}

/* ------------------------------------------------------------------ */
/*  Load                                                                */
/* ------------------------------------------------------------------ */
async function loadData() {
  setStatus("Loading data…");
  try {
    const fetched = await Promise.all(
      CENTER_SHEETS.map((c) => fetchSheetRows(c.gid).then((rows) => ({ center: c.name, rows })))
    );

    const perCenterCatalogs = [];
    const allPersons = [];
    fetched.forEach(({ center, rows }) => {
      const { catalog, persons } = parseCenterSheet(rows, center);
      perCenterCatalogs.push(catalog);
      allPersons.push(...persons);
    });

    const masterCatalog = mergeCatalogs(perCenterCatalogs);
    const canonicalizeUncatalogued = makeUncatalogueClusterer();
    designationCache.clear();

    RECORDS = [];
    allPersons.forEach((p) => {
      const base = {
        name: titleCase(p.name),
        center: p.center,
        designation: canonicalizeDesignation(p.designation),
        mode: canonicalizeMode(p.mode),
      };
      const personRecords = buildPersonRecords(p.doneRaw, p.notdoneRaw, masterCatalog, base, canonicalizeUncatalogued);
      RECORDS.push(...dedupePersonRecords(personRecords));
    });

    setStatus(`Loaded ${RECORDS.length} matched records across ${CENTER_SHEETS.length} centers · updated ${new Date().toLocaleString()}`);
    buildTypeColors();
    buildFilterOptions();
    render();
  } catch (err) {
    console.error(err);
    setStatus(
      "Could not load one or more sheet tabs. Make sure the sheet is shared as “Anyone with the link – Viewer”. (" + err.message + ")",
      true
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Filters                                                            */
/* ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);

function fillSelect(el, values, keep) {
  const cur = el.value;
  el.innerHTML = `<option value="">${keep}</option>` +
    values.map((v) => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join("");
  el.value = cur;
}

function uniqueSorted(key) {
  return [...new Set(RECORDS.map((r) => r[key]).filter(Boolean))].sort();
}

function buildFilterOptions() {
  const centers = [...new Set([...CENTER_SHEETS.map((c) => c.name), ...uniqueSorted("center")])];
  fillSelect($("centerFilter"), centers, "All centers");
  fillSelect($("designationFilter"), uniqueSorted("designation"), "All designations");
  fillSelect($("topicFilter"), uniqueSorted("topic"), "All topics");
  fillSelect($("typeFilter"), uniqueSorted("type"), "All types");
  fillSelect($("personFilter"), uniqueSorted("name"), "All people");
}

function currentFilters() {
  return {
    center: $("centerFilter").value,
    person: $("personFilter").value,
    designation: $("designationFilter").value,
    topic: $("topicFilter").value,
    type: $("typeFilter").value,
    status: $("statusFilter").value,
    from: $("fromDate").value ? new Date($("fromDate").value) : null,
    to: $("toDate").value ? new Date($("toDate").value + "T23:59:59") : null,
  };
}

function applyFilters() {
  const f = currentFilters();
  return RECORDS.filter((r) => {
    if (f.center && r.center !== f.center) return false;
    if (f.person && r.name !== f.person) return false;
    if (f.designation && r.designation !== f.designation) return false;
    if (f.topic && r.topic !== f.topic) return false;
    if (f.type && r.type !== f.type) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.from && (!r.date || r.date < f.from)) return false;
    if (f.to && (!r.date || r.date > f.to)) return false;
    return true;
  });
}

/* ------------------------------------------------------------------ */
/*  Render                                                             */
/* ------------------------------------------------------------------ */
function render() {
  const rows = applyFilters();
  const personMode = !!$("personFilter").value;
  $("personPanel").hidden = !personMode;
  $("overviewCharts").hidden = personMode;

  renderKpis(rows);
  if (personMode) renderPersonPanel(rows);
  renderPeopleTable(rows);
  renderTimeChart(rows);
  renderPeopleCharts(rows);
  renderAttendanceCenterChart(rows);
  renderAttendanceDesigChart(rows);
  renderTypeChart(rows);
  renderTypeLegend();
  renderModeChart(rows);
  renderTopicsChart(rows);
  renderMatrix(rows);
  renderTable(rows);
}

/* ------------------------------------------------------------------ */
/*  People overview: one row per person, with a total training count   */
/*  instead of one row per record.                                     */
/* ------------------------------------------------------------------ */
function aggregateByPerson(rows) {
  const m = new Map();
  rows.forEach((r) => {
    if (!m.has(r.name)) {
      m.set(r.name, {
        name: r.name, centers: new Set(), designations: new Set(),
        total: 0, done: 0, notdone: 0, types: new Map(),
      });
    }
    const p = m.get(r.name);
    if (r.center) p.centers.add(r.center);
    if (r.designation) p.designations.add(r.designation);
    p.total += 1;
    if (r.status === "Done") p.done += 1; else p.notdone += 1;
    p.types.set(r.type, (p.types.get(r.type) || 0) + 1);
  });
  return [...m.values()].map((p) => ({
    ...p,
    center: [...p.centers].join(", "),
    designation: [...p.designations].join(", "),
    rate: p.total ? Math.round((p.done / p.total) * 100) : 0,
  }));
}

function renderPeopleTable(rows) {
  const people = aggregateByPerson(rows);
  people.sort((a, b) => {
    let av = a[peopleSortKey], bv = b[peopleSortKey];
    if (typeof av === "string") { av = av.toLowerCase(); bv = String(bv).toLowerCase(); }
    return av < bv ? peopleSortDir : av > bv ? -peopleSortDir : 0;
  });

  $("peopleCount").textContent = `(${people.length} ${people.length === 1 ? "person" : "people"})`;
  $("peopleTable").querySelector("tbody").innerHTML = people.map((p) => {
    const typeChips = [...p.types.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `<span class="chip" style="background:${typeColor(t)}22;color:${typeColor(t)}"><span class="chip-dot" style="background:${typeColor(t)}"></span>${escapeHtml(t)} · ${n}</span>`)
      .join("");
    return `<tr data-name="${escapeAttr(p.name)}">
      <td class="rowhead">${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.center)}</td>
      <td>${escapeHtml(p.designation)}</td>
      <td>${p.total}</td>
      <td>${p.done}</td>
      <td>${p.notdone}</td>
      <td>${p.rate}%</td>
      <td class="chips">${typeChips}</td>
    </tr>`;
  }).join("");

  $("peopleTable").querySelectorAll("tbody tr").forEach((tr) => {
    tr.addEventListener("click", () => {
      $("personFilter").value = tr.dataset.name;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function renderTypeLegend() {
  const el = $("typeLegend");
  if (!el) return;
  el.innerHTML = [...TYPE_COLORS.entries()].map(([t, c]) =>
    `<span class="legend-item"><span class="legend-dot" style="background:${c}"></span>${escapeHtml(t)}</span>`
  ).join("");
}

const CHARTS = {};
function draw(id, config) {
  CHARTS[id] && CHARTS[id].destroy();
  CHARTS[id] = new Chart($(id), config);
}
const barOpts = (extra = {}, recordsFor = null) => {
  const o = {
    responsive: true,
    scales: {
      x: { ticks: { color: TICK }, grid: { color: GRID }, ...(extra.x || {}) },
      y: { ticks: { color: TICK }, grid: { color: GRID }, beginAtZero: true, ...(extra.y || {}) },
    },
    plugins: { legend: { labels: { color: LABEL } }, ...(extra.plugins || {}) },
    ...(extra.root || {}),
  };
  return recordsFor ? withPeopleTip(o, recordsFor) : o;
};

function distinctPeopleBy(rows, key) {
  const m = new Map();
  rows.forEach((r) => {
    const k = r[key] || "(blank)";
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(r.name.toLowerCase());
  });
  return m;
}

const byField = (rows, key, label) => rows.filter((r) => (r[key] || "(blank)") === label);

function renderPeopleCharts(rows) {
  [["peopleCenterChart", "center"], ["peopleDesigChart", "designation"]].forEach(([id, key]) => {
    const m = distinctPeopleBy(rows, key);
    const labels = [...m.keys()].sort((a, b) => m.get(b).size - m.get(a).size);
    draw(id, {
      type: "bar",
      data: {
        labels,
        datasets: [{ label: "People", data: labels.map((l) => m.get(l).size), backgroundColor: PALETTE[key === "center" ? 0 : 1] }],
      },
      options: barOpts({
        plugins: { legend: { display: false } },
      }, (ds, i) => ({
        title: `${key === "center" ? "Centre" : "Designation"}: ${labels[i]}`,
        records: byField(rows, key, labels[i]),
      })),
    });
  });
}

// Simple two-color (Done / Not done) stacked bar, grouped by whichever
// field is passed in — this is the primary "distinguish by X" chart.
function renderStatusChart(id, rows, key) {
  const labels = [...groupCount(rows, key).keys()].sort();
  const isDone = (r) => r.status === "Done";
  draw(id, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Done", backgroundColor: "#8fc9a1", data: labels.map((l) => rows.filter((r) => (r[key] || "(blank)") === l && isDone(r)).length) },
        { label: "Not done", backgroundColor: "#d29a9a", data: labels.map((l) => rows.filter((r) => (r[key] || "(blank)") === l && !isDone(r)).length) },
      ],
    },
    options: barOpts({ root: { indexAxis: "y" }, x: { stacked: true }, y: { stacked: true } }, (ds, i) => {
      const l = labels[i];
      const want = ds === 0;
      return {
        title: `${l} — ${want ? "Done" : "Not done"}`,
        records: rows.filter((r) => (r[key] || "(blank)") === l && isDone(r) === want),
      };
    }),
  });
}
function renderAttendanceCenterChart(rows) { renderStatusChart("attendanceCenterChart", rows, "center"); }
function renderAttendanceDesigChart(rows) { renderStatusChart("attendanceDesigChart", rows, "designation"); }

function doughnut(id, rows, key, label, colorFor) {
  const map = groupCount(rows, key);
  const labels = [...map.keys()];
  const colors = colorFor ? labels.map(colorFor) : labels.map((_, i) => PALETTE[i % PALETTE.length]);
  draw(id, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data: labels.map((l) => map.get(l)), backgroundColor: colors, borderColor: "#fff", borderWidth: 2 }],
    },
    options: withPeopleTip(
      { responsive: true, plugins: { legend: { position: "bottom", labels: { color: LABEL } } } },
      (ds, i) => ({ title: `${label}: ${labels[i]}`, records: byField(rows, key, labels[i]) })
    ),
  });
}
function renderTypeChart(rows) { doughnut("typeChart", rows, "type", "Type", typeColor); }
function renderModeChart(rows) { doughnut("modeChart", rows, "mode", "Mode"); }

function renderTopicsChart(rows) {
  const m = groupCount(rows, "topic");
  const labels = [...m.keys()].sort((a, b) => m.get(b) - m.get(a)).slice(0, 10);
  draw("topicsChart", {
    type: "bar",
    data: { labels, datasets: [{ label: "Records", data: labels.map((l) => m.get(l)), backgroundColor: PALETTE[3] }] },
    options: barOpts({ root: { indexAxis: "y" }, plugins: { legend: { display: false } } },
      (ds, i) => ({ title: `Topic: ${labels[i]}`, records: byField(rows, "topic", labels[i]) })),
  });
}

const MATRIX_CELLS = new Map(); // "center|||desig" -> array of records
const cellKey = (c, d) => c + "|||" + d;

function renderMatrix(rows) {
  const centers = [...new Set([...CENTER_SHEETS.map((c) => c.name), ...rows.map((r) => r.center)])].filter(Boolean);
  const desigs = [...new Set(rows.map((r) => r.designation))].filter(Boolean).sort();

  MATRIX_CELLS.clear();
  rows.forEach((r) => {
    const k = cellKey(r.center, r.designation);
    if (!MATRIX_CELLS.has(k)) MATRIX_CELLS.set(k, []);
    MATRIX_CELLS.get(k).push(r);
  });
  const at = (c, d) => (MATRIX_CELLS.get(cellKey(c, d)) || []).length;
  let max = 0;
  centers.forEach((c) => desigs.forEach((d) => { max = Math.max(max, at(c, d)); }));

  const head = `<thead><tr><th>Center \\ Designation</th>${desigs.map((d) => `<th>${escapeHtml(d)}</th>`).join("")}<th>Total</th></tr></thead>`;
  const body = centers.map((c) => {
    const cells = desigs.map((d) => {
      const n = at(c, d);
      const a = max ? n / max : 0;
      const bg = n ? `background:rgba(63,159,196,${(0.12 + a * 0.6).toFixed(2)})` : "";
      const cls = "cell" + (n ? "" : " empty");
      return `<td class="${cls}" style="${bg}" data-c="${escapeAttr(c)}" data-d="${escapeAttr(d)}">${n || ""}</td>`;
    }).join("");
    const total = desigs.reduce((s, d) => s + at(c, d), 0);
    return `<tr><td class="rowhead">${escapeHtml(c)}</td>${cells}<td class="total">${total}</td></tr>`;
  }).join("");
  const totalsRow = `<tr class="totals"><td>Total</td>${desigs.map((d) => `<td>${centers.reduce((s, c) => s + at(c, d), 0)}</td>`).join("")}<td>${rows.length}</td></tr>`;

  $("matrixTable").innerHTML = head + `<tbody>${body}${totalsRow}</tbody>`;
  $("matrixTable").querySelectorAll("td.cell").forEach((td) => {
    td.addEventListener("click", () => {
      if (td.classList.contains("empty")) return;
      $("centerFilter").value = td.dataset.c;
      $("designationFilter").value = td.dataset.d;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    td.addEventListener("mouseenter", (e) => showCellTip(e, td, td.dataset.c, td.dataset.d));
    td.addEventListener("mouseleave", scheduleHideCellTip);
  });
}

/* ------------------------------------------------------------------ */
/*  Shared "who is behind this number" hover card                      */
/* ------------------------------------------------------------------ */
let cellTipTimer = null;

function cellTipEl() {
  let el = $("cellTip");
  if (!el) {
    el = document.createElement("div");
    el.id = "cellTip";
    el.hidden = true;
    el.addEventListener("mouseenter", () => clearTimeout(cellTipTimer));
    el.addEventListener("mouseleave", hideCellTip);
    document.body.appendChild(el);
  }
  return el;
}

function scheduleHideCellTip() {
  clearTimeout(cellTipTimer);
  cellTipTimer = setTimeout(hideCellTip, 220);
}

function hideCellTip() {
  clearTimeout(cellTipTimer);
  const el = $("cellTip");
  if (el) { el.hidden = true; el.dataset.key = ""; }
}

function peopleCardHTML(title, records, footer) {
  if (!records || !records.length) {
    return `<div class="ct-head">${escapeHtml(title)}</div>` +
      `<div class="ct-empty">No matching training records.</div>`;
  }
  const recs = records.slice().sort((a, b) => (b.date || 0) - (a.date || 0));
  const byPerson = new Map();
  recs.forEach((r) => {
    if (!byPerson.has(r.name)) byPerson.set(r.name, []);
    byPerson.get(r.name).push(r);
  });
  const MAX_PEOPLE = 6;
  const MAX_ITEMS = 2;
  const shown = [...byPerson.entries()].slice(0, MAX_PEOPLE);
  const people = shown.map(([name, list]) => {
    const desig = list[0].designation || "—";
    const visible = list.slice(0, MAX_ITEMS);
    const items = visible.map((r) =>
      `<li><span class="ct-topic">${escapeHtml(r.topic || "—")}</span>` +
      `<span class="ct-meta">${fmtDate(r.date)} · ${escapeHtml(r.status)}</span></li>`
    ).join("");
    const more = list.length > visible.length
      ? `<li class="ct-more">+${list.length - visible.length} more</li>` : "";
    return `<div class="ct-person"><div class="ct-name">${escapeHtml(name)} ` +
      `<span class="ct-desig">${escapeHtml(desig)}</span>` +
      `<span class="ct-count">${list.length}</span></div>` +
      `<ul>${items}${more}</ul></div>`;
  }).join("");
  const overflow = byPerson.size > MAX_PEOPLE
    ? `<div class="ct-more-people">+${byPerson.size - MAX_PEOPLE} more people</div>` : "";
  return `<div class="ct-head">${escapeHtml(title)} ` +
    `<span class="ct-total">${byPerson.size} ${byPerson.size === 1 ? "person" : "people"} · ${recs.length} records</span></div>` +
    people +
    overflow +
    (footer ? `<div class="ct-foot">${escapeHtml(footer)}</div>` : "");
}

function placeCard(el, rect) {
  const pad = 10;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let x = rect.right + pad;
  if (x + w > window.innerWidth - 8) x = rect.left - w - pad;
  if (x < 8) x = Math.max(8, (window.innerWidth - w) / 2);
  let y = rect.top;
  if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
  el.style.left = Math.round(x) + "px";
  el.style.top = Math.round(Math.max(8, y)) + "px";
}

function openCard(key, html, rect) {
  const el = cellTipEl();
  clearTimeout(cellTipTimer);
  if (el.dataset.key === key && !el.hidden) return;
  el.dataset.key = key;
  el.innerHTML = html;
  el.hidden = false;
  placeCard(el, rect);
}

function showCellTip(e, td, center, desig) {
  const recs = MATRIX_CELLS.get(cellKey(center, desig)) || [];
  const html = recs.length
    ? peopleCardHTML(`${desig} · ${center}`, recs, "Click the cell to filter the dashboard to this group")
    : `<div class="ct-head">${escapeHtml(desig)} · ${escapeHtml(center)}</div>` +
      `<div class="ct-empty">No training recorded for this role at this center.</div>`;
  openCard("cell:" + center + "|" + desig, html, td.getBoundingClientRect());
}

function peopleTooltipHandler(recordsFor) {
  return (ctx) => {
    const { chart, tooltip } = ctx;
    if (!tooltip || tooltip.opacity === 0) { scheduleHideCellTip(); return; }
    const dp = tooltip.dataPoints && tooltip.dataPoints[0];
    if (!dp) return;
    const info = recordsFor(dp.datasetIndex, dp.dataIndex, chart) || {};
    const key = `${chart.canvas.id}:${dp.datasetIndex}:${dp.dataIndex}`;
    const canvasRect = chart.canvas.getBoundingClientRect();
    const px = canvasRect.left + tooltip.caretX;
    const py = canvasRect.top + tooltip.caretY;
    openCard(key, peopleCardHTML(info.title || "", info.records || [], info.footer), {
      left: px, right: px, top: py, bottom: py,
    });
  };
}

function withPeopleTip(options, recordsFor) {
  options.plugins = options.plugins || {};
  options.plugins.tooltip = Object.assign({}, options.plugins.tooltip, {
    enabled: false,
    external: peopleTooltipHandler(recordsFor),
  });
  return options;
}

let personChart;
function renderPersonPanel(rows) {
  const selected = $("personFilter").value;
  $("personName").textContent = selected || "all people (pick one in the Person filter)";

  const done = rows.filter((r) => r.status === "Done");
  const topics = groupCount(rows, "topic");
  const centers = [...new Set(rows.map((r) => r.center).filter(Boolean))];

  $("pTrainings").textContent = rows.length;
  $("pTopics").textContent = topics.size;
  $("pRate").textContent = rows.length ? Math.round((done.length / rows.length) * 100) + "%" : "0%";
  $("pCenters").textContent = centers.length ? centers.join(", ") : "–";

  const labels = [...topics.keys()].sort();
  personChart && personChart.destroy();
  personChart = new Chart($("personChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Matched records",
        data: labels.map((l) => topics.get(l)),
        backgroundColor: PALETTE[0],
      }],
    },
    options: withPeopleTip({
      indexAxis: "y",
      responsive: true,
      scales: {
        x: { ticks: { color: TICK, precision: 0 }, grid: { color: GRID }, beginAtZero: true },
        y: { ticks: { color: TICK }, grid: { color: GRID } },
      },
      plugins: { legend: { labels: { color: LABEL } } },
    }, (ds, i) => ({
      title: `Topic: ${labels[i]}`,
      records: rows.filter((r) => (r.topic || "(blank)") === labels[i]),
    })),
  });
}

function renderKpis(rows) {
  $("kpiRecords").textContent = rows.length;
  $("kpiPeople").textContent = new Set(rows.map((r) => r.name.toLowerCase())).size;
  $("kpiSessions").textContent = new Set(
    rows.map((r) => r.topic + "|" + (r.date ? r.date.toDateString() : ""))
  ).size;
  $("kpiPresent").textContent = rows.filter((r) => r.status === "Done").length;
}

function groupCount(rows, key) {
  const m = new Map();
  rows.forEach((r) => {
    const k = r[key] || "(blank)";
    m.set(k, (m.get(k) || 0) + 1);
  });
  return m;
}

function renderTimeChart(rows) {
  const m = new Map();
  rows.forEach((r) => {
    if (!r.date) return;
    const k = `${r.date.getFullYear()}-${String(r.date.getMonth() + 1).padStart(2, "0")}`;
    m.set(k, (m.get(k) || 0) + 1);
  });
  const labels = [...m.keys()].sort();
  const monthOf = (r) => r.date ? `${r.date.getFullYear()}-${String(r.date.getMonth() + 1).padStart(2, "0")}` : "";
  timeChart && timeChart.destroy();
  timeChart = new Chart($("timeChart"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Training records",
        data: labels.map((l) => m.get(l)),
        borderColor: "#3f9fc4",
        backgroundColor: "rgba(63,159,196,0.15)",
        fill: true,
        tension: 0.3,
      }],
    },
    options: withPeopleTip({
      responsive: true,
      scales: {
        x: { ticks: { color: TICK }, grid: { color: GRID } },
        y: { ticks: { color: TICK }, grid: { color: GRID }, beginAtZero: true },
      },
      plugins: { legend: { labels: { color: LABEL } } },
    }, (ds, i) => ({
      title: `Trainings in ${labels[i]}`,
      records: rows.filter((r) => monthOf(r) === labels[i]),
    })),
  });
}

function fmtDate(d) {
  return d ? d.toLocaleDateString("en-GB") : "";
}

function renderTable(rows) {
  const sorted = [...rows].sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (sortKey === "date") { av = av ? av.getTime() : 0; bv = bv ? bv.getTime() : 0; }
    else { av = String(av).toLowerCase(); bv = String(bv).toLowerCase(); }
    return av < bv ? sortDir : av > bv ? -sortDir : 0;
  });

  $("tableCount").textContent = `(${sorted.length})`;
  $("detailTable").querySelector("tbody").innerHTML = sorted.map((r) => {
    const done = r.status === "Done";
    return `<tr>
      <td>${fmtDate(r.date)}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.center)}</td>
      <td>${escapeHtml(r.designation)}</td>
      <td><span class="type-dot" style="background:${typeColor(r.type)}"></span>${escapeHtml(r.type)}</td>
      <td>${escapeHtml(r.topic)}</td>
      <td>${escapeHtml(r.mode || "")}</td>
      <td><span class="badge ${done ? "done" : "notdone"}">${escapeHtml(r.status)}</span></td>
    </tr>`;
  }).join("");
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function setStatus(msg, isError) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

/* ------------------------------------------------------------------ */
/*  Events                                                             */
/* ------------------------------------------------------------------ */
["centerFilter", "personFilter", "designationFilter", "topicFilter", "typeFilter",
 "statusFilter", "fromDate", "toDate"].forEach((id) =>
  $(id).addEventListener("change", render));

$("resetBtn").addEventListener("click", () => {
  ["centerFilter", "personFilter", "designationFilter", "topicFilter", "typeFilter", "statusFilter", "fromDate", "toDate"]
    .forEach((id) => ($(id).value = ""));
  render();
});
$("refreshBtn").addEventListener("click", loadData);
$("clearPersonBtn").addEventListener("click", () => {
  $("personFilter").value = "";
  render();
});

document.querySelectorAll("#detailTable th").forEach((th) =>
  th.addEventListener("click", () => {
    const k = th.dataset.key;
    if (sortKey === k) sortDir *= -1;
    else { sortKey = k; sortDir = 1; }
    render();
  }));

document.querySelectorAll("#peopleTable th[data-key]").forEach((th) =>
  th.addEventListener("click", () => {
    const k = th.dataset.key;
    if (peopleSortKey === k) peopleSortDir *= -1;
    else { peopleSortKey = k; peopleSortDir = k === "name" ? 1 : -1; }
    renderPeopleTable(applyFilters());
  }));

loadData();