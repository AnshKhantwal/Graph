"use strict";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */
const SHEET_ID = "1AeH_0IxlJuO00DU58EyAhTQdymOvjyNLrwnc9Ol3Who";
// gviz endpoint works when the sheet is shared as "Anyone with the link can view".
const GVIZ_URL =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json`;

const CENTERS = ["Durgapuri", "Shahdara", "Mayur Vihar", "Keshav Puram", "Uttam Nagar", "Tigri", "Head Office"];
const DESIGNATIONS = ["Manager", "Reception", "Billing", "Pharmacy", "Lab Technician", "Counsellor", "Patient Coordinator", "Call Center", "Marketing", "Doctor Assistant", "Other"];

// soft palette on a light background
const PALETTE = ["#7fbfd8", "#a99fd4", "#dc9dc0", "#e0c07f", "#8fc9a1", "#e0a97e", "#84c4c0", "#d29a9a", "#b6a4d6", "#a6b2c6", "#93c7bc"];
const GRID = "rgba(43,54,72,0.10)";
const TICK = "#6b7688";
const LABEL = "#2b3648";

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */
let RECORDS = [];          // normalised rows
let sortKey = "date";
let sortDir = -1;          // -1 = desc
let mainChart, timeChart;

/* ------------------------------------------------------------------ */
/*  Fetch + parse                                                      */
/* ------------------------------------------------------------------ */
async function loadData() {
  setStatus("Loading data…");
  try {
    const res = await fetch(GVIZ_URL, { cache: "no-store" });
    const text = await res.text();
    const json = JSON.parse(text.replace(/^[\s\S]*?setResponse\(/, "").replace(/\);?\s*$/, ""));
    RECORDS = normalise(json.table);
    setStatus(`Loaded ${RECORDS.length} records · updated ${new Date().toLocaleString()}`);
    buildFilterOptions();
    render();
  } catch (err) {
    console.error(err);
    setStatus(
      "Could not load the sheet. Make sure it is shared as “Anyone with the link – Viewer”, " +
      "or File → Share → Publish to web. (" + err.message + ")",
      true
    );
  }
}

// map fuzzy header text -> canonical key
function headerKey(label) {
  const l = String(label || "").toLowerCase().trim();
  if (l.includes("timestamp")) return "timestamp";
  if (l === "date" || l.includes("date")) return "date";
  if (l.includes("mode")) return "mode";
  if (l.includes("material") || l.includes("shared")) return "shared";
  if (l.includes("center") || l.includes("centre")) return "center";
  if (l.includes("designation")) return "designation";
  if (l.includes("attendance")) return "attendance";
  if (l.includes("topic") && (l.includes("cord") || l.includes("code"))) return "topicCode";
  if (l.includes("type")) return "type";
  if (l.includes("topic")) return "topic";
  if (l === "name" || l.includes("name")) return "name";
  return "col_" + l.replace(/\W+/g, "_");
}

function cellDate(cell) {
  if (!cell) return null;
  if (cell.f && /\d/.test(cell.f)) {
    // f like "02/09/2026" (dd/mm/yyyy)
    const m = cell.f.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  }
  if (typeof cell.v === "string") {
    const m = cell.v.match(/Date\((\d+),(\d+),(\d+)/);
    if (m) return new Date(+m[1], +m[2], +m[3]);
  }
  const d = new Date(cell.v);
  return isNaN(d) ? null : d;
}

function normalise(table) {
  const keys = table.cols.map((c) => headerKey(c.label));
  return table.rows.map((r) => {
    const o = {};
    (r.c || []).forEach((cell, i) => {
      const k = keys[i];
      if (k === "date" || k === "timestamp") {
        o[k] = cellDate(cell);
      } else {
        o[k] = cell && cell.v != null ? String(cell.v).trim() : "";
      }
    });
    if (!o.date && o.timestamp) o.date = o.timestamp;
    o.name = o.name || "(no name)";
    o.attendance = o.attendance || "Present";
    return o;
  }).filter((o) => o.center || o.designation || o.topic);
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
  // prefer the canonical lists, but include anything extra seen in the data
  const centers = [...new Set([...CENTERS, ...uniqueSorted("center")])];
  const desigs = [...new Set([...DESIGNATIONS, ...uniqueSorted("designation")])];
  fillSelect($("centerFilter"), centers, "All centers");
  fillSelect($("designationFilter"), desigs, "All designations");
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
    attendance: $("attendanceFilter").value,
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
    if (f.attendance && r.attendance.toLowerCase() !== f.attendance.toLowerCase()) return false;
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
  const personMode = $("viewMode").value === "person";
  $("personPanel").hidden = !personMode;
  document.querySelector(".chart-wrap").hidden = personMode;

  renderKpis(rows);
  if (personMode) renderPersonPanel(rows);
  else renderMainChart(rows);
  renderTimeChart(rows);
  renderPeopleCharts(rows);
  renderAttendanceCenterChart(rows);
  renderTypeChart(rows);
  renderModeChart(rows);
  renderTopicsChart(rows);
  renderMatrix(rows);
  renderTable(rows);
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

function renderAttendanceCenterChart(rows) {
  const centers = [...groupCount(rows, "center").keys()].sort();
  const isP = (r) => r.attendance.toLowerCase() === "present";
  draw("attendanceCenterChart", {
    type: "bar",
    data: {
      labels: centers,
      datasets: [
        { label: "Present", backgroundColor: "#8fc9a1", data: centers.map((c) => rows.filter((r) => (r.center || "(blank)") === c && isP(r)).length) },
        { label: "Absent", backgroundColor: "#d29a9a", data: centers.map((c) => rows.filter((r) => (r.center || "(blank)") === c && !isP(r)).length) },
      ],
    },
    options: barOpts({ x: { stacked: true }, y: { stacked: true } }, (ds, i) => {
      const c = centers[i];
      const want = ds === 0;
      return {
        title: `${c} — ${want ? "Present" : "Absent"}`,
        records: rows.filter((r) => (r.center || "(blank)") === c && isP(r) === want),
      };
    }),
  });
}

function doughnut(id, rows, key, label) {
  const map = groupCount(rows, key);
  const labels = [...map.keys()];
  draw(id, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data: labels.map((l) => map.get(l)), backgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length]), borderColor: "#fff", borderWidth: 2 }],
    },
    options: withPeopleTip(
      { responsive: true, plugins: { legend: { position: "bottom", labels: { color: LABEL } } } },
      (ds, i) => ({ title: `${label}: ${labels[i]}`, records: byField(rows, key, labels[i]) })
    ),
  });
}
function renderTypeChart(rows) { doughnut("typeChart", rows, "type", "Type"); }
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
  const centers = [...new Set([...CENTERS, ...rows.map((r) => r.center)])].filter(Boolean);
  const desigs = [...new Set([...DESIGNATIONS, ...rows.map((r) => r.designation)])].filter(Boolean);

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
    // let the pointer move into the card to scroll a long list
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

// build the grouped-by-person body used by every hover card
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
  const people = [...byPerson.entries()].map(([name, list]) => {
    const desig = list[0].designation || "—";
    const center = [...new Set(list.map((r) => r.center).filter(Boolean))].join(", ");
    const items = list.map((r) =>
      `<li><span class="ct-topic">${escapeHtml(r.topic || "—")}</span>` +
      `<span class="ct-meta">${fmtDate(r.date)} · ${escapeHtml(r.attendance)}` +
      `${r.mode ? " · " + escapeHtml(r.mode) : ""}</span></li>`
    ).join("");
    return `<div class="ct-person"><div class="ct-name">${escapeHtml(name)} ` +
      `<span class="ct-desig">${escapeHtml(desig)}</span>` +
      `${center ? `<span class="ct-desig ct-loc">${escapeHtml(center)}</span>` : ""}` +
      `<span class="ct-count">${list.length} session${list.length === 1 ? "" : "s"}</span></div>` +
      `<ul>${items}</ul></div>`;
  }).join("");
  return `<div class="ct-head">${escapeHtml(title)} ` +
    `<span class="ct-total">${byPerson.size} ${byPerson.size === 1 ? "person" : "people"} · ${recs.length} records</span></div>` +
    people +
    (footer ? `<div class="ct-foot">${escapeHtml(footer)}</div>` : "");
}

// position the card beside an on-screen rectangle (a table cell, or a point on a chart)
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
  if (el.dataset.key === key && !el.hidden) return; // already showing this one
  el.dataset.key = key;
  el.innerHTML = html;
  el.hidden = false;
  placeCard(el, rect);
}

/* ---- matrix cell hover ---- */
function showCellTip(e, td, center, desig) {
  const recs = MATRIX_CELLS.get(cellKey(center, desig)) || [];
  const html = recs.length
    ? peopleCardHTML(`${desig} · ${center}`, recs, "Click the cell to filter the dashboard to this group")
    : `<div class="ct-head">${escapeHtml(desig)} · ${escapeHtml(center)}</div>` +
      `<div class="ct-empty">No training recorded for this role at this center.</div>`;
  openCard("cell:" + center + "|" + desig, html, td.getBoundingClientRect());
}

/* ---- generic chart hover: reuse the same card on any Chart.js chart ---- */
// recordsFor(dsIndex, index, chart) -> { title, records, footer }
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

// attach the handler to a chart config's tooltip (disables the native bubble)
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

  const present = rows.filter((r) => r.attendance.toLowerCase() === "present");
  const topics = groupCount(rows, "topic");
  const centers = [...new Set(rows.map((r) => r.center).filter(Boolean))];

  $("pTrainings").textContent = rows.length;
  $("pTopics").textContent = topics.size;
  $("pRate").textContent = rows.length ? Math.round((present.length / rows.length) * 100) + "%" : "0%";
  $("pCenters").textContent = centers.length ? centers.join(", ") : "–";

  const labels = [...topics.keys()].sort();
  personChart && personChart.destroy();
  personChart = new Chart($("personChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Times attended",
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
  $("kpiPresent").textContent = rows.filter((r) => r.attendance.toLowerCase() === "present").length;
}

function groupCount(rows, key) {
  const m = new Map();
  rows.forEach((r) => {
    const k = r[key] || "(blank)";
    m.set(k, (m.get(k) || 0) + 1);
  });
  return m;
}

function renderMainChart(rows) {
  const mode = $("viewMode").value; // center | designation
  const primaryKey = mode === "center" ? "center" : "designation";
  const stackKey = mode === "center" ? "designation" : "center";
  $("chartTitle").textContent =
    `Attendance by ${primaryKey}` + ` (stacked by ${stackKey})`;

  const primaries = [...groupCount(rows, primaryKey).keys()].sort();
  const stacks = [...groupCount(rows, stackKey).keys()].sort();

  const datasets = stacks.map((s, i) => ({
    label: s,
    backgroundColor: PALETTE[i % PALETTE.length],
    data: primaries.map(
      (p) => rows.filter((r) => (r[primaryKey] || "(blank)") === p && (r[stackKey] || "(blank)") === s).length
    ),
  }));

  mainChart && mainChart.destroy();
  mainChart = new Chart($("mainChart"), {
    type: "bar",
    data: { labels: primaries, datasets },
    options: withPeopleTip({
      responsive: true,
      scales: {
        x: { stacked: true, ticks: { color: TICK }, grid: { color: GRID } },
        y: { stacked: true, ticks: { color: TICK }, grid: { color: GRID }, beginAtZero: true },
      },
      plugins: { legend: { labels: { color: LABEL } } },
    }, (ds, i) => {
      const p = primaries[i], s = stacks[ds];
      return {
        title: `${p} · ${s}`,
        records: rows.filter((r) => (r[primaryKey] || "(blank)") === p && (r[stackKey] || "(blank)") === s),
      };
    }),
  });
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
        label: "Attendance records",
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
    const present = r.attendance.toLowerCase() === "present";
    return `<tr>
      <td>${fmtDate(r.date)}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.center)}</td>
      <td>${escapeHtml(r.designation)}</td>
      <td>${escapeHtml(r.topic)}</td>
      <td>${escapeHtml(r.type || "")}</td>
      <td>${escapeHtml(r.mode || "")}</td>
      <td><span class="badge ${present ? "present" : "absent"}">${escapeHtml(r.attendance)}</span></td>
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
["viewMode", "centerFilter", "personFilter", "designationFilter", "topicFilter", "typeFilter",
 "attendanceFilter", "fromDate", "toDate"].forEach((id) =>
  $(id).addEventListener("change", render));

$("resetBtn").addEventListener("click", () => {
  ["centerFilter", "personFilter", "designationFilter", "topicFilter", "typeFilter", "attendanceFilter", "fromDate", "toDate"]
    .forEach((id) => ($(id).value = ""));
  render();
});
$("refreshBtn").addEventListener("click", loadData);

document.querySelectorAll("#detailTable th").forEach((th) =>
  th.addEventListener("click", () => {
    const k = th.dataset.key;
    if (sortKey === k) sortDir *= -1;
    else { sortKey = k; sortDir = 1; }
    render();
  }));

loadData();
