"use strict";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */
const SHEET_ID = "1AeH_0IxlJuO00DU58EyAhTQdymOvjyNLrwnc9Ol3Who";
const FORM_GID = "1455977731";
const ROSTER_GID = "1858539177";

// range=A2:Z explicitly skips the header row — gviz's own header detection
// is unreliable on a sheet that has no data rows yet (e.g. an empty roster).
const gvizUrl = (gid) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&gid=${gid}&range=A2:Z`;

// Fixed column layout of the "Form Responses" sheet (0-indexed), one row per
// submitted training log entry — no catalog/module rows to parse anymore:
// A timestamp | B date | C training mode | D training module |
// E material/module shared? | F center name | G designation | H full name |
// I training topic code (optional) | J type of training
const COL = { DATE: 1, MODE: 2, MODULE: 3, SHARED: 4, CENTER: 5, DESIGNATION: 6, NAME: 7, TOPIC_CODE: 8, TYPE: 9 };

// Fixed column layout of the "masterlog" roster tab (0-indexed):
// A s.no | B name | C center | D designation
const ROSTER_COL = { NAME: 1, CENTER: 2, DESIGNATION: 3 };

// Muted categorical palette — deliberately desaturated so no single series
// shouts louder than the data. Mirrors the tokens in styles.css.
const PALETTE = ["#4a63d8", "#17926b", "#b5822e", "#8465c4", "#2b8a9e", "#c06c84", "#6b7f9e", "#a2714a", "#5f9ea0", "#9a8fb8"];
// Completion is shown as progress, not as a pass/fail traffic light:
// "done" is the accent fill, "remaining" is a neutral track.
const DONE_COLOR = "#17926b";
const TRACK_COLOR = "#e9ecf1";
const ACCENT = "#4a63d8";
const GRID = "rgba(22,31,45,0.06)";
const TICK = "#98a2b3";
const LABEL = "#667085";

// Consistent look across every Chart.js instance on the page.
if (window.Chart) {
  Chart.defaults.font.family = "'Inter', 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = TICK;
  Chart.defaults.borderColor = GRID;
  Chart.defaults.plugins.legend.labels.boxWidth = 8;
  Chart.defaults.plugins.legend.labels.boxHeight = 8;
  Chart.defaults.plugins.legend.labels.padding = 14;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.pointStyle = "circle";
  Chart.defaults.elements.bar.borderRadius = 4;
  Chart.defaults.elements.bar.borderSkipped = false;
  Chart.defaults.elements.line.borderWidth = 2;
  Chart.defaults.elements.point.radius = 0;
  Chart.defaults.elements.point.hoverRadius = 4;
  Chart.defaults.elements.arc.borderWidth = 2;
  Chart.defaults.elements.arc.borderColor = "#ffffff";
}

/* Completion helpers shared by every progress-style view ------------- */
function completionOf(rows) {
  const total = rows.length;
  const done = rows.filter((r) => r.status === "Done").length;
  return { total, done, open: total - done, pct: total ? Math.round((done / total) * 100) : 0 };
}

function pctClass(pct) {
  return pct < 40 ? "low" : pct < 70 ? "mid" : "";
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */
let RECORDS = [];          // one entry per form-submitted training log row
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
    (r.c || []).map((cell) => (cell ? String(cell.f != null ? cell.f : (cell.v != null ? cell.v : "")) : ""))
  );
}

/* ------------------------------------------------------------------ */
/*  Parsing: each row of the Form Responses sheet is already one       */
/*  training-log entry for one person — no catalog/module matching     */
/*  needed, just read the columns directly.                            */
/* ------------------------------------------------------------------ */
function parseDMY(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return isNaN(d) ? null : d;
}

// Strips a stray leading list number ("8. Doctors Training – Retraining"),
// left over from pasting a numbered curriculum list into the module field,
// so it doesn't get treated as a different training from the same module
// typed without the prefix elsewhere.
function stripNumbering(s) {
  return String(s || "").replace(/^\s*\d+[.)]\s*/, "").trim();
}

// Every submitted row is a completed training log entry.
function parseFormRow(r) {
  const name = (r[COL.NAME] || "").trim();
  if (!name) return null;
  return {
    name: titleCase(name),
    center: canonicalizeCenter(r[COL.CENTER]),
    designation: canonicalizeDesignation(r[COL.DESIGNATION]),
    mode: canonicalizeMode(r[COL.MODE]),
    type: (r[COL.TYPE] || "").trim(),
    topic: stripNumbering(r[COL.MODULE]),
    date: parseDMY(r[COL.DATE]),
    status: "Done",
  };
}

// One row per employee expected to attend training at a center. The Center
// column is only filled on the first row of each center's block (a visual
// merge in the sheet) — blank cells below it belong to the same center, so
// we carry the last-seen value forward. Placeholder rows ("na" — no one
// currently fills that role) are skipped so they don't get flagged forever.
function parseRosterRows(rows) {
  let lastCenter = "";
  const out = [];
  rows.forEach((r) => {
    const centerRaw = (r[ROSTER_COL.CENTER] || "").trim();
    if (centerRaw) lastCenter = centerRaw;
    const name = (r[ROSTER_COL.NAME] || "").trim();
    if (!name || !lastCenter || /^n\/?a$/i.test(name)) return;
    out.push({
      name: titleCase(name),
      center: canonicalizeCenter(lastCenter),
      designation: canonicalizeDesignation(r[ROSTER_COL.DESIGNATION]),
    });
  });
  return out;
}

// A name counts as "the same person" if it's a close typo (Levenshtein) or
// shares the same first word — covers cases like the roster listing someone
// with a suffix ("Bhawna Di") that the form entry drops ("Bhawna").
function stripHonorific(s) {
  return normalize(s).replace(/^(dr|mr|mrs|ms|md)\s+/, "");
}
function namesLikelySame(a, b) {
  if (similarity(a, b) >= 0.72) return true;
  const sa = stripHonorific(a), sb = stripHonorific(b);
  if (sa && sb && (sa === sb || similarity(sa, sb) >= 0.72)) return true;
  const wa = normalize(a).split(" ")[0], wb = normalize(b).split(" ")[0];
  return wa.length >= 3 && wa === wb;
}

// Reconciles a form entry's typed name against the roster's spelling for
// that same center, so typos on either side don't create a "duplicate"
// person who looks 100% done on one spelling and 100% not-done on the other.
const attendeeNameCache = new Map();
function canonicalizeAttendeeName(rawName, center, roster) {
  const key = normalize(rawName) + "|||" + normalize(center);
  if (attendeeNameCache.has(key)) return attendeeNameCache.get(key);
  let best = null, bestScore = 0;
  roster.forEach((p) => {
    if (normalize(p.center) !== normalize(center)) return;
    const s = similarity(rawName, p.name);
    if (s > bestScore) { bestScore = s; best = p.name; }
  });
  const result = (best && (bestScore >= 0.72 || namesLikelySame(rawName, best))) ? best : rawName;
  attendeeNameCache.set(key, result);
  return result;
}

/* ------------------------------------------------------------------ */
/*  Derive "Not done" records: for every (center, module) that was     */
/*  actually conducted (per the form log), any roster member at that   */
/*  center with no matching form entry is flagged Not done. This is    */
/*  fully automatic — nothing is typed into either sheet by hand.      */
/*                                                                      */
/*  NOTE: this is intentionally NOT scoped by designation. Scoping by  */
/*  (center, designation) was tried and reverted — nearly every role   */
/*  has exactly one person per center, so there was no peer to compare */
/*  against and "not done" nearly vanished. Scoping by designation      */
/*  alone (pooled across all centers) was also tried and reverted —    */
/*  most roles' curricula overlap so heavily across centers that it    */
/*  also nearly vanished. Center-only is the version that actually     */
/*  produces usable results, at the cost of occasionally flagging a    */
/*  role-specific session (e.g. a Pharmacy-only training) against      */
/*  someone in another role at the same center.                       */
/*                                                                      */
/*  A session is identified by module alone, not module+type: the      */
/*  Type Of Training field is free text and gets logged inconsistently */
/*  for the same real module (e.g. one person picks "cps upgrade",     */
/*  another picks "knowledge at medcross" for the identical training), */
/*  and keying on the pair would treat that as two different sessions —*/
/*  wrongly flagging someone "not done" on a training they did attend, */
/*  just under the other type label. The type shown is whichever label */
/*  was used most often for that module.                               */
/* ------------------------------------------------------------------ */
function buildNotDoneRecords(doneRecords, roster) {
  const sessionsByCenter = new Map(); // normalized center -> Map(topic -> {topic, typeCounts})
  doneRecords.forEach((r) => {
    if (!r.center || !r.topic) return;
    const centerKey = normalize(r.center);
    const topicKey = normalize(r.topic);
    if (!sessionsByCenter.has(centerKey)) sessionsByCenter.set(centerKey, new Map());
    const sessions = sessionsByCenter.get(centerKey);
    if (!sessions.has(topicKey)) sessions.set(topicKey, { topic: r.topic, typeCounts: new Map() });
    const entry = sessions.get(topicKey);
    entry.typeCounts.set(r.type, (entry.typeCounts.get(r.type) || 0) + 1);
  });

  const attended = new Set(
    doneRecords.map((r) => [normalize(r.name), normalize(r.center), normalize(r.topic)].join("|||"))
  );

  const notDone = [];
  roster.forEach((person) => {
    const sessions = sessionsByCenter.get(normalize(person.center));
    if (!sessions) return;
    sessions.forEach(({ topic, typeCounts }) => {
      const key = [normalize(person.name), normalize(person.center), normalize(topic)].join("|||");
      if (!attended.has(key)) {
        const type = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        notDone.push({
          name: person.name, center: person.center, designation: person.designation,
          mode: "", type, topic, date: null, status: "Not done",
        });
      }
    });
  });
  return notDone;
}

// A person's done training is a one-time "did it happen" fact per module,
// not an attendance counter — if the same real training got logged twice
// under two different Type Of Training values (the free-text field is
// inconsistent, same as in buildNotDoneRecords above), keep just one row so
// it doesn't inflate their count or double the length of its chart bar.
function dedupeDoneRecords(doneRecords) {
  const seen = new Set();
  return doneRecords.filter((r) => {
    const key = [normalize(r.name), normalize(r.center), normalize(r.topic)].join("|||");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
      // adjacent transposition (e.g. "pranav" vs "parnav") counts as one
      // edit instead of two, matching how people actually mistype names.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
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

/* ---- Center name canonicalization ---- */
// The known 5 centers. Fixes typos like "shahdra" so the same center reads
// consistently everywhere and, more importantly, so a typo doesn't split
// one center's roster/attendance into two mismatched buckets.
const CENTER_DICTIONARY = ["Shahdara", "Tigri", "Uttam Nagar", "Keshav Puram", "Mayur Vihar"];
const centerCache = new Map();
function canonicalizeCenter(raw) {
  const key = normalize(raw);
  if (!key) return "";
  if (centerCache.has(key)) return centerCache.get(key);
  let best = null, bestScore = 0;
  CENTER_DICTIONARY.forEach((c) => {
    const s = similarity(key, normalize(c));
    if (s > bestScore) { bestScore = s; best = c; }
  });
  const result = bestScore >= 0.72 ? best : titleCase(raw);
  centerCache.set(key, result);
  return result;
}

const CENTER_TAGS = { Shahdara: "SH", Tigri: "TG", "Uttam Nagar": "UN", "Keshav Puram": "KP", "Mayur Vihar": "MV" };

// The People table and every filter/group treat a person by name alone, so
// two different real people who happen to share a first name at different
// centers (e.g. two "Manisha"s) would otherwise get silently merged into
// one row with combined counts. Tag only the names that actually collide
// across centers — unique names stay untouched — so they read as distinct
// people everywhere (e.g. "Manisha (KP)" vs "Manisha (UN)"). Collisions are
// detected from the final record set, not just the roster, so a stray
// form entry at the wrong center still gets separated from the real person
// of the same name elsewhere.
function tagAmbiguousNames(records) {
  const centersByName = new Map();
  records.forEach((r) => {
    const key = normalize(r.name);
    if (!centersByName.has(key)) centersByName.set(key, new Set());
    centersByName.get(key).add(r.center);
  });
  const colliding = new Set(
    [...centersByName.entries()].filter(([, centers]) => centers.size > 1).map(([k]) => k)
  );
  records.forEach((r) => {
    if (colliding.has(normalize(r.name))) {
      r.name = `${r.name} (${CENTER_TAGS[r.center] || r.center})`;
    }
  });
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

/* ------------------------------------------------------------------ */
/*  Load                                                                */
/* ------------------------------------------------------------------ */
async function loadData() {
  setStatus("Loading data…");
  try {
    const [formRows, rosterRows] = await Promise.all([
      fetchSheetRows(FORM_GID),
      fetchSheetRows(ROSTER_GID),
    ]);
    designationCache.clear();
    centerCache.clear();
    attendeeNameCache.clear();

    let doneRecords = formRows.map(parseFormRow).filter(Boolean);
    const roster = parseRosterRows(rosterRows);
    doneRecords.forEach((r) => { r.name = canonicalizeAttendeeName(r.name, r.center, roster); });
    doneRecords = dedupeDoneRecords(doneRecords);
    const notDoneRecords = buildNotDoneRecords(doneRecords, roster);
    RECORDS = doneRecords.concat(notDoneRecords);
    tagAmbiguousNames(RECORDS);

    setStatus(
      `Loaded ${doneRecords.length} done + ${notDoneRecords.length} not-done records ` +
      `(${roster.length} roster entries) · updated ${new Date().toLocaleString()}`
    );
    buildTypeColors();
    buildFilterOptions();
    render();
  } catch (err) {
    console.error(err);
    setStatus(
      "Could not load the form responses or roster sheet. Make sure both are shared as “Anyone with the link – Viewer”. (" + err.message + ")",
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
  fillSelect($("centerFilter"), uniqueSorted("center"), "All centers");
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
  $("overviewStrip").hidden = personMode;

  $("focusRow").hidden = personMode;

  renderKpis(rows);
  if (!personMode) {
    renderGauge(rows);
    renderProgressList("centerProgress", rows, "center", "centerFilter");
    renderProgressList("desigProgress", rows, "designation", "designationFilter");
    renderAttention(rows);
    renderGaps(rows);
  }
  if (personMode) renderPersonPanel(rows);
  renderPeopleTable(rows);
  renderTimeChart(rows);
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
      <td>
        <span class="cell-progress">
          <span class="attn-bar"><i style="width:${p.rate}%"></i></span>
          <span class="pct ${pctClass(p.rate)}">${p.rate}%</span>
        </span>
      </td>
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

const byField = (rows, key, label) => rows.filter((r) => (r[key] || "(blank)") === label);

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
  const centers = [...new Set(rows.map((r) => r.center))].filter(Boolean);
  const desigs = [...new Set(rows.map((r) => r.designation))].filter(Boolean).sort();

  MATRIX_CELLS.clear();
  rows.forEach((r) => {
    const k = cellKey(r.center, r.designation);
    if (!MATRIX_CELLS.has(k)) MATRIX_CELLS.set(k, []);
    MATRIX_CELLS.get(k).push(r);
  });
  const cellsAt = (c, d) => MATRIX_CELLS.get(cellKey(c, d)) || [];

  // Shade by completion rate, not raw volume: a cell answers "how far along
  // is this role at this centre", which is the question the dashboard exists
  // to answer. Single-hue ramp — darker simply means more complete.
  const shade = (pct) => {
    const a = (0.08 + (pct / 100) * 0.85).toFixed(2);
    return `background:rgba(23,146,107,${a});color:${pct > 55 ? "#fff" : "#16324a"}`;
  };

  const head = `<thead><tr><th>Centre</th>${desigs.map((d) => `<th>${escapeHtml(d)}</th>`).join("")}<th>Overall</th></tr></thead>`;
  const body = centers.map((c) => {
    const cells = desigs.map((d) => {
      const list = cellsAt(c, d);
      if (!list.length) {
        return `<td class="cell empty" data-c="${escapeAttr(c)}" data-d="${escapeAttr(d)}">–</td>`;
      }
      const k = completionOf(list);
      return `<td class="cell" style="${shade(k.pct)}" title="${k.done}/${k.total} complete"
        data-c="${escapeAttr(c)}" data-d="${escapeAttr(d)}">${k.pct}%</td>`;
    }).join("");
    const rowTotal = completionOf(desigs.flatMap((d) => cellsAt(c, d)));
    return `<tr><td class="rowhead">${escapeHtml(c)}</td>${cells}<td class="total">${rowTotal.pct}%</td></tr>`;
  }).join("");
  const totalsRow = `<tr class="totals"><td>All centres</td>${desigs.map((d) => {
    const k = completionOf(centers.flatMap((c) => cellsAt(c, d)));
    return `<td>${k.total ? k.pct + "%" : "–"}</td>`;
  }).join("")}<td>${completionOf(rows).pct}%</td></tr>`;

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
    el.className = "ct-card";
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

function peopleListHTML(byPerson, maxItemsPerPerson) {
  return [...byPerson.entries()].map(([name, list]) => {
    const desig = list[0].designation || "—";
    const visible = maxItemsPerPerson ? list.slice(0, maxItemsPerPerson) : list;
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
}

function groupByPerson(records) {
  const recs = records.slice().sort((a, b) => (b.date || 0) - (a.date || 0));
  const byPerson = new Map();
  recs.forEach((r) => {
    if (!byPerson.has(r.name)) byPerson.set(r.name, []);
    byPerson.get(r.name).push(r);
  });
  return byPerson;
}

// Keyed by the same stable key the caller already uses for its tooltip/cell
// (e.g. "cell:Shahdara|Manager"), so repeated hovers over the same bar reuse
// one entry instead of piling up a new one on every tooltip repaint.
const FULL_LIST_DATA = new Map();

function peopleCardHTML(title, records, footer, cardKey) {
  if (!records || !records.length) {
    return `<div class="ct-head">${escapeHtml(title)}</div>` +
      `<div class="ct-empty">No matching training records.</div>`;
  }
  const byPerson = groupByPerson(records);
  const MAX_PEOPLE = 6;
  const MAX_ITEMS = 2;
  const truncated = byPerson.size > MAX_PEOPLE || [...byPerson.values()].some((list) => list.length > MAX_ITEMS);
  const shown = new Map([...byPerson.entries()].slice(0, MAX_PEOPLE));
  const overflow = byPerson.size > MAX_PEOPLE
    ? `<div class="ct-more-people">+${byPerson.size - MAX_PEOPLE} more people</div>` : "";
  let showAllBtn = "";
  if (truncated && cardKey) {
    FULL_LIST_DATA.set(cardKey, { title, records });
    showAllBtn = `<button type="button" class="ct-show-all" data-list-id="${escapeAttr(cardKey)}">` +
      `Show all ${byPerson.size} people · ${records.length} records</button>`;
  }
  return `<div class="ct-head">${escapeHtml(title)} ` +
    `<span class="ct-total">${byPerson.size} ${byPerson.size === 1 ? "person" : "people"} · ${records.length} records</span></div>` +
    peopleListHTML(shown, MAX_ITEMS) +
    overflow +
    showAllBtn +
    (footer ? `<div class="ct-foot">${escapeHtml(footer)}</div>` : "");
}

function fullListModalEl() {
  let el = $("fullListModal");
  if (!el) {
    el = document.createElement("div");
    el.id = "fullListModal";
    el.className = "modal-overlay";
    el.hidden = true;
    el.innerHTML = `<div class="modal-box"><button type="button" class="modal-close" aria-label="Close">&times;</button>` +
      `<div class="ct-card modal-content"></div></div>`;
    el.addEventListener("click", (e) => { if (e.target === el) closeFullListModal(); });
    el.querySelector(".modal-close").addEventListener("click", closeFullListModal);
    document.body.appendChild(el);
  }
  return el;
}

function closeFullListModal() {
  const el = $("fullListModal");
  if (el) el.hidden = true;
}

function openFullList(title, records) {
  if (!records || !records.length) return;
  hideCellTip();
  const byPerson = groupByPerson(records);
  const el = fullListModalEl();
  el.querySelector(".modal-content").innerHTML =
    `<div class="ct-head">${escapeHtml(title)} ` +
    `<span class="ct-total">${byPerson.size} ${byPerson.size === 1 ? "person" : "people"} · ${records.length} records</span></div>` +
    peopleListHTML(byPerson, null);
  el.hidden = false;
}

function openFullListModal(id) {
  const data = FULL_LIST_DATA.get(id);
  if (data) openFullList(data.title, data.records);
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
  const key = "cell:" + center + "|" + desig;
  const recs = MATRIX_CELLS.get(cellKey(center, desig)) || [];
  const html = recs.length
    ? peopleCardHTML(`${desig} · ${center}`, recs, "Click the cell to filter the dashboard to this group", key)
    : `<div class="ct-head">${escapeHtml(desig)} · ${escapeHtml(center)}</div>` +
      `<div class="ct-empty">No training recorded for this role at this center.</div>`;
  openCard(key, html, td.getBoundingClientRect());
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
    openCard(key, peopleCardHTML(info.title || "", info.records || [], info.footer, key), {
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
  // Clicking a bar/segment/slice opens the full people list right away,
  // instead of requiring a hover first and then a "Show all" click.
  options.onClick = (evt, elements, chart) => {
    if (!elements.length) return;
    const el = elements[0];
    const info = recordsFor(el.datasetIndex, el.index, chart) || {};
    openFullList(info.title || "", info.records || []);
  };
  return options;
}

// A bar chart of per-person module status is useless (every bar is length 1),
// so the profile renders as a checklist grouped by training type instead —
// each module is a ticked or open row, which is what you actually want to
// read: what has this person done, and what is still outstanding.
function renderPersonPanel(rows) {
  const selected = $("personFilter").value;
  $("personName").textContent = selected || "all people (pick one in the Person filter)";

  const c = completionOf(rows);
  const topics = groupCount(rows, "topic");
  const centers = [...new Set(rows.map((r) => r.center).filter(Boolean))];

  $("pTrainings").textContent = c.total;
  $("pTopics").textContent = topics.size;
  $("pRate").textContent = c.pct + "%";
  $("pCenters").textContent = centers.length ? centers.join(", ") : "–";

  // group by training type, exactly as typed in the sheet
  const byType = new Map();
  rows.forEach((r) => {
    const t = (r.type || "").trim() || "Uncategorised";
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(r);
  });

  const groups = [...byType.entries()].sort((a, b) => b[1].length - a[1].length);
  const el = $("personChecklist");

  if (!groups.length) {
    el.innerHTML = `<div class="progress-empty">No training records for this person.</div>`;
    return;
  }

  el.innerHTML = groups.map(([type, list]) => {
    const g = completionOf(list);
    // outstanding first — that is the part that needs action
    const items = list.slice().sort((a, b) => {
      const ad = a.status === "Done" ? 1 : 0;
      const bd = b.status === "Done" ? 1 : 0;
      return ad - bd || (a.topic || "").localeCompare(b.topic || "");
    });
    return `
      <div class="checklist-group">
        <div class="checklist-head">
          <span class="checklist-title" title="${escapeAttr(type)}">${escapeHtml(type)}</span>
          <span class="checklist-count">${g.done}/${g.total} · ${g.pct}%</span>
        </div>
        ${items.map((r) => {
          const isDone = r.status === "Done";
          return `<div class="checklist-item ${isDone ? "is-done" : "is-open"}">
            <span class="tick">${isDone ? "✓" : ""}</span>
            <span class="ci-name">${escapeHtml(r.topic || "—")}${r.date ? `<span class="ci-date">${fmtDate(r.date)}</span>` : ""}</span>
          </div>`;
        }).join("")}
      </div>`;
  }).join("");
}

function renderKpis(rows) {
  $("kpiRecords").textContent = rows.length;
  $("kpiPresent").textContent = rows.filter((r) => r.status === "Done").length;
  $("kpiNotDone").textContent = rows.filter((r) => r.status === "Not done").length;
  $("kpiPeople").textContent = new Set(rows.map((r) => r.name.toLowerCase())).size;
  $("kpiSessions").textContent = new Set(
    rows.map((r) => r.topic + "|" + (r.date ? r.date.toDateString() : ""))
  ).size;
}

let gaugeChart;
function renderGauge(rows) {
  const c = completionOf(rows);
  $("gaugePct").textContent = c.pct + "%";
  $("gaugeDone").textContent = c.done;
  $("gaugeNotDone").textContent = c.open;

  gaugeChart && gaugeChart.destroy();
  gaugeChart = new Chart($("overallGaugeChart"), {
    type: "doughnut",
    data: {
      datasets: [{
        data: c.total ? [c.done, c.open] : [0, 1],
        backgroundColor: [DONE_COLOR, TRACK_COLOR],
        borderWidth: 0,
        borderRadius: 10,
      }],
    },
    options: {
      responsive: true,
      cutout: "82%",
      animation: { animateRotate: true, duration: 500 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Completion progress rows — a plain bar chart of a binary status    */
/*  carries almost no information (every bar is the same length), so   */
/*  these render as ranked progress meters instead: share complete,    */
/*  counts, and a click-through to filter.                             */
/* ------------------------------------------------------------------ */
function renderProgressList(elId, rows, key, filterId) {
  const groups = new Map();
  rows.forEach((r) => {
    const k = r[key] || "(blank)";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });

  const entries = [...groups.entries()]
    .map(([label, list]) => ({ label, ...completionOf(list) }))
    .sort((a, b) => b.pct - a.pct || b.total - a.total);

  const el = $(elId);
  if (!entries.length) {
    el.innerHTML = `<div class="progress-empty">No records match the current filters.</div>`;
    return;
  }

  el.innerHTML = entries.map((e) => `
    <div class="progress-row" data-value="${escapeAttr(e.label)}" data-filter="${filterId}">
      <div class="progress-label" title="${escapeAttr(e.label)}">${escapeHtml(e.label)}</div>
      <div class="progress-track"><div class="progress-fill" style="width:${e.pct}%"></div></div>
      <div class="progress-meta"><b>${e.pct}%</b>${e.done}/${e.total}</div>
    </div>`).join("");
}

/* People furthest behind — the actionable "who do I chase" view. */
function renderAttention(rows) {
  const people = aggregateByPerson(rows)
    .filter((p) => p.total > 0)
    .sort((a, b) => a.rate - b.rate || b.notdone - a.notdone)
    .slice(0, 8);

  const el = $("attentionList");
  if (!people.length) {
    el.innerHTML = `<div class="progress-empty">Nothing outstanding — everyone is fully trained.</div>`;
    return;
  }

  el.innerHTML = people.map((p) => `
    <div class="attn-row" data-name="${escapeAttr(p.name)}">
      <div>
        <div class="attn-name">${escapeHtml(p.name)}</div>
        <div class="attn-sub">${escapeHtml(p.designation || "—")} · ${escapeHtml(p.center || "—")} · ${p.notdone} outstanding</div>
      </div>
      <div class="attn-right">
        <div class="attn-bar"><i style="width:${p.rate}%"></i></div>
        <div class="pct ${pctClass(p.rate)}">${p.rate}%</div>
      </div>
    </div>`).join("");
}

/* Modules with the most people still outstanding — what to schedule next. */
function renderGaps(rows) {
  const byTopic = new Map();
  rows.forEach((r) => {
    const k = r.topic || "(blank)";
    if (!byTopic.has(k)) byTopic.set(k, []);
    byTopic.get(k).push(r);
  });

  const entries = [...byTopic.entries()]
    .map(([label, list]) => ({ label, ...completionOf(list) }))
    .filter((e) => e.open > 0)
    .sort((a, b) => b.open - a.open || a.pct - b.pct)
    .slice(0, 8);

  const el = $("gapList");
  if (!entries.length) {
    el.innerHTML = `<div class="progress-empty">No outstanding modules for the current filters.</div>`;
    return;
  }

  el.innerHTML = entries.map((e) => `
    <div class="progress-row" data-value="${escapeAttr(e.label)}" data-filter="topicFilter">
      <div class="progress-label" title="${escapeAttr(e.label)}">${escapeHtml(e.label)}</div>
      <div class="progress-track"><div class="progress-fill" style="width:${e.pct}%"></div></div>
      <div class="progress-meta"><b>${e.open}</b>pending</div>
    </div>`).join("");
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
        label: "Trainings logged",
        data: labels.map((l) => m.get(l)),
        borderColor: ACCENT,
        backgroundColor: "rgba(74,99,216,0.08)",
        fill: true,
        tension: 0.35,
      }],
    },
    options: withPeopleTip({
      responsive: true,
      scales: {
        x: { ticks: { color: TICK }, grid: { display: false }, border: { color: GRID } },
        y: { ticks: { color: TICK, precision: 0 }, grid: { color: GRID }, border: { display: false }, beginAtZero: true },
      },
      plugins: { legend: { display: false } },
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

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".ct-show-all");
  if (btn) { openFullListModal(btn.dataset.listId); return; }

  // A progress row drills into whatever it represents (centre, role, module).
  const progressRow = e.target.closest(".progress-row");
  if (progressRow) {
    $(progressRow.dataset.filter).value = progressRow.dataset.value;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  const attnRow = e.target.closest(".attn-row");
  if (attnRow) {
    $("personFilter").value = attnRow.dataset.name;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeFullListModal();
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