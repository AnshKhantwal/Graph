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
  renderTable(rows);
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
    options: {
      indexAxis: "y",
      responsive: true,
      scales: {
        x: { ticks: { color: TICK, precision: 0 }, grid: { color: GRID }, beginAtZero: true },
        y: { ticks: { color: TICK }, grid: { color: GRID } },
      },
      plugins: { legend: { labels: { color: LABEL } } },
    },
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
    options: {
      responsive: true,
      scales: {
        x: { stacked: true, ticks: { color: TICK }, grid: { color: GRID } },
        y: { stacked: true, ticks: { color: TICK }, grid: { color: GRID }, beginAtZero: true },
      },
      plugins: { legend: { labels: { color: LABEL } } },
    },
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
    options: {
      responsive: true,
      scales: {
        x: { ticks: { color: TICK }, grid: { color: GRID } },
        y: { ticks: { color: TICK }, grid: { color: GRID }, beginAtZero: true },
      },
      plugins: { legend: { labels: { color: LABEL } } },
    },
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
