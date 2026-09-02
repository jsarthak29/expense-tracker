// Expense Tracker UI — vanilla JS, same-origin fetches, zero dependencies.
//
// The wire contract is fixed (see ../contract/openapi.yaml). This file only
// decides how the data is presented: every request uses the documented query
// parameters, and list totals always come from the X-Total-Count header.
//
// Nothing here is hardcoded. Where the API has no purpose-built endpoint —
// the daily trend, the month-over-month delta, the average — the number is
// derived from real rows the documented endpoints already return.

const PAGE_SIZE = 20;
const RECENT_SIZE = 6;
const FETCH_CAP = 200;          // the backend's own page_size ceiling
const TREND_PAGE_CAP = 5;       // at most 1000 rows pulled for one month

const DEFAULT_FILTERS = { sort: "date", order: "desc" };
const NARROWING = ["q", "category", "date_from", "date_to", "amount_min", "amount_max"];

const SORT_LABELS = { date: "Date", amount: "Amount", title: "Description", category: "Category" };

const KNOWN_TONES = new Set([
  "food", "transport", "utilities", "entertainment",
  "shopping", "health", "rent", "travel",
]);

const VIEWS = ["overview", "expenses", "analytics"];

let currentView = "overview";
let currentPage = 1;
let currentFilters = { ...DEFAULT_FILTERS };
let totalCount = 0;

// ─── DOM ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const layout = document.querySelector(".layout");
const errorBanner = $("error-banner");
const errorText = $("error-text");
const summaryMonth = $("summary-month");
const monthWrap = $("month-wrap");
const toasts = $("toasts");

const head = { eyebrow: $("page-eyebrow"), title: $("page-title"), sub: $("page-sub") };

const kpi = {
  total: $("kpi-total"), totalMeta: $("kpi-total-meta"), delta: $("kpi-delta"),
  count: $("kpi-count"), countMeta: $("kpi-count-meta"),
  avg: $("kpi-avg"),
  top: $("kpi-top"), topMeta: $("kpi-top-meta"),
};

const trend = $("trend");
const trendSub = $("trend-sub");
const trendPeak = $("trend-peak");
const trendTip = $("trend-tip");
const trendTipDate = $("trend-tip-date");
const trendTipValue = $("trend-tip-value");
const cats = $("cats");
const catsMeta = $("cats-meta");
const catsDetail = $("cats-detail");
const detailMeta = $("detail-meta");
const months = $("months");
const recent = $("recent");

const tbody = $("expenses-tbody");
const resultCount = $("result-count");
const pagination = $("pagination");
const pageInfo = $("page-info");
const pagePrev = $("page-prev");
const pageNext = $("page-next");

const filterForm = $("filter-form");
const filterPanel = $("filter-panel");
const filterToggle = $("filter-toggle");
const filterCount = $("filter-count");
const sortBtn = $("sort-btn");
const sortLabel = $("sort-label");
const sortArrow = $("sort-arrow");

const addForm = $("add-form");
const addModal = $("add-modal");
const addError = $("add-error");
const addSubmit = $("add-submit");
const confirmModal = $("confirm-modal");

// ─── Formatting ───────────────────────────────────────────────────────────
const moneyFmt = new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR",
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const money = (n) => moneyFmt.format(Number(n) || 0);
const num = (n) => Number(n || 0).toLocaleString("en-IN");

/** Compact axis labels: 90000 -> "₹90k". */
function shortMoney(n) {
  const v = Number(n) || 0;
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(v >= 1e8 ? 0 : 1)}Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(v >= 1e6 ? 0 : 1)}L`;
  if (v >= 1e3) return `₹${Math.round(v / 1e3)}k`;
  return `₹${Math.round(v)}`;
}

const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

const fmtMonth = (ym) => {
  if (!ym) return "";
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
};

const fmtMonthShort = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short" });
};

const currentMonthISO = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

const daysInMonth = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
};

/** "2026-07", 8 -> "2026-07-09" (zero-based day index). */
const dayISO = (ym, i) => `${ym}-${String(i + 1).padStart(2, "0")}`;

/** "2026-07" -> { from: "2026-07-01", to: "2026-07-31" } */
function monthRange(ym) {
  return { from: `${ym}-01`, to: `${ym}-${String(daysInMonth(ym)).padStart(2, "0")}` };
}

/** Step a "YYYY-MM" string back by n months. */
function shiftMonth(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 - n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Categories are free text, so unknown ones fall back to a neutral tone. */
function toneClass(category) {
  if (!category) return "tone--none";
  const slug = category.trim().toLowerCase();
  return KNOWN_TONES.has(slug) ? `tone--${slug}` : "tone--other";
}

const label = (category) => (category ? category : "Uncategorized");

// ─── Feedback ─────────────────────────────────────────────────────────────
function showError(message) {
  errorText.textContent = message;
  errorBanner.hidden = false;
}

const clearError = () => { errorBanner.hidden = true; };

$("error-dismiss").addEventListener("click", clearError);
$("error-retry").addEventListener("click", () => { clearError(); render(); });

function toast(message, kind = "success") {
  const el = document.createElement("div");
  el.className = kind === "error" ? "toast toast--error" : "toast";
  el.innerHTML = `<span class="toast__dot"></span><span></span>`;
  el.lastElementChild.textContent = message;
  toasts.append(el);
  setTimeout(() => el.remove(), 3200);
}

/** Turn a failed response into one sentence a non-developer can act on. */
async function describeFailure(res) {
  let detail = "";
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") {
      detail = body.detail;
    } else if (Array.isArray(body?.detail)) {
      detail = body.detail
        .map((e) => `${(e.loc || []).slice(1).join(".") || "request"}: ${e.msg}`)
        .join("; ");
    }
  } catch {
    /* not JSON — fall through */
  }
  if (detail) return detail;
  if (res.status === 404) return "That record no longer exists.";
  if (res.status === 422) return "Some values were not accepted. Please check the form.";
  if (res.status >= 500) return "The server hit an unexpected error. Please try again.";
  return `The request failed (${res.status} ${res.statusText}).`;
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...opts,
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
    });
  } catch {
    const err = new Error("network");
    err.friendly = "We couldn't reach the server. Is the API still running?";
    throw err;
  }
  if (!res.ok) {
    const err = new Error(String(res.status));
    err.status = res.status;
    err.friendly = await describeFailure(res);
    throw err;
  }
  return res;
}

/** GET /expenses returning both the rows and the X-Total-Count header. */
async function listExpenses(params) {
  const res = await api(`/expenses?${params}`);
  const rows = await res.json();
  const header = res.headers.get("X-Total-Count");
  return { rows, total: header != null ? Number(header) : rows.length };
}

// ─── Routing ──────────────────────────────────────────────────────────────
function viewFromHash() {
  const name = (location.hash || "").replace(/^#\/?/, "");
  return VIEWS.includes(name) ? name : "overview";
}

function setView(name) {
  currentView = name;

  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  for (const link of document.querySelectorAll(".nav__item")) {
    link.classList.toggle("is-active", link.dataset.view === name);
  }

  const month = fmtMonth(summaryMonth.value);
  if (name === "overview") {
    head.eyebrow.textContent = "Dashboard";
    head.title.textContent = `${greeting()} 👋`;
    head.sub.textContent = `Here's your spending overview for ${month}.`;
  } else if (name === "expenses") {
    head.eyebrow.textContent = "Expenses";
    head.title.textContent = "All transactions";
    head.sub.textContent = "Search, filter and manage every recorded expense.";
  } else {
    head.eyebrow.textContent = "Analytics";
    head.title.textContent = "Spending analysis";
    head.sub.textContent = `Category and month-on-month breakdown around ${month}.`;
  }

  monthWrap.hidden = name === "expenses";
  layout.classList.remove("nav-open");
  $("sidebar-scrim").hidden = true;
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });

  render();
}

window.addEventListener("hashchange", () => setView(viewFromHash()));

$("nav-toggle").addEventListener("click", () => {
  const open = !layout.classList.contains("nav-open");
  layout.classList.toggle("nav-open", open);
  $("sidebar-scrim").hidden = !open;
});

$("sidebar-scrim").addEventListener("click", () => {
  layout.classList.remove("nav-open");
  $("sidebar-scrim").hidden = true;
});

// ─── Skeletons ────────────────────────────────────────────────────────────
const skelLine = (w, cls = "") => `<span class="skeleton ${cls}" style="width:${w}"></span>`;

function skeletonOverview() {
  for (const el of [kpi.total, kpi.count, kpi.avg, kpi.top]) el.innerHTML = skelLine("68%", "skeleton--lg");
  for (const el of [kpi.totalMeta, kpi.countMeta, kpi.topMeta]) el.innerHTML = skelLine("70px", "skeleton--sm");
  kpi.delta.innerHTML = "";
  trend.innerHTML = `<span class="skeleton skeleton--block"></span>`;
  trendSub.textContent = "";
  trendPeak.textContent = "";
  cats.innerHTML = Array.from({ length: 5 }, () =>
    `<div class="cat">${skelLine("55%", "skeleton--sm")}${skelLine("60px", "skeleton--sm")}</div>`).join("");
  catsMeta.textContent = "";
  recent.innerHTML = Array.from({ length: 4 }, () =>
    `<li class="feed__row">${skelLine("100%")}</li>`).join("");
}

function skeletonRows() {
  tbody.innerHTML = Array.from({ length: 6 }, () =>
    `<tr class="state-row"><td colspan="5">${skelLine("100%")}</td></tr>`).join("");
}

function renderTableState(title, detail, { action = false } = {}) {
  tbody.innerHTML = `
    <tr class="state-row">
      <td colspan="5" class="state-cell">
        <div class="state-title">${escapeHtml(title)}</div>
        ${detail ? `<div class="state-detail">${escapeHtml(detail)}</div>` : ""}
        ${action ? `<div class="state-action"><button type="button" class="btn btn--primary" id="state-add">+ Add Expense</button></div>` : ""}
      </td>
    </tr>`;
  $("state-add")?.addEventListener("click", openAddModal);
}

// ─── Overview ─────────────────────────────────────────────────────────────

/** Pull every row of a month so the daily trend is built from real records. */
async function fetchMonthRows(month) {
  const { from, to } = monthRange(month);
  const rows = [];
  let total = Infinity;

  for (let page = 1; page <= TREND_PAGE_CAP && rows.length < total; page++) {
    const params = new URLSearchParams({
      page, page_size: FETCH_CAP, date_from: from, date_to: to, sort: "date", order: "asc",
    });
    const res = await listExpenses(params);
    total = res.total;
    rows.push(...res.rows);
    if (res.rows.length < FETCH_CAP) break;
  }
  return { rows, total: total === Infinity ? rows.length : total };
}

async function loadOverview() {
  const month = summaryMonth.value || currentMonthISO();
  skeletonOverview();

  let summary;
  let monthRows;
  let previous = null;
  try {
    const [summaryRes, rowsRes, prevRes] = await Promise.all([
      api(`/summary?month=${encodeURIComponent(month)}`).then((r) => r.json()),
      fetchMonthRows(month),
      api(`/summary?month=${encodeURIComponent(shiftMonth(month, 1))}`).then((r) => r.json()).catch(() => null),
    ]);
    summary = summaryRes;
    monthRows = rowsRes;
    previous = prevRes;
  } catch (err) {
    showError(err.friendly || "We couldn't load your dashboard.");
    for (const el of [kpi.total, kpi.count, kpi.avg, kpi.top]) el.textContent = "—";
    for (const el of [kpi.totalMeta, kpi.countMeta, kpi.topMeta, kpi.delta]) el.textContent = "";
    trend.innerHTML = "";
    cats.innerHTML = "";
    recent.innerHTML = "";
    return;
  }

  if (!summary || typeof summary.total !== "number" || !Array.isArray(summary.by_category)) {
    showError("The server returned an unexpected shape for GET /summary.");
    return;
  }

  const monthLabel = fmtMonth(summary.month);
  const count = monthRows.total;

  kpi.total.textContent = money(summary.total);
  kpi.totalMeta.textContent = monthLabel;
  kpi.delta.innerHTML = renderDelta(summary.total, previous?.total);

  kpi.count.textContent = num(count);
  kpi.countMeta.textContent = count === 1 ? "transaction this month" : "transactions this month";

  kpi.avg.textContent = count > 0 ? money(summary.total / count) : "—";

  const top = summary.by_category[0]; // backend already orders by spend, desc
  kpi.top.textContent = top ? label(top.category) : "—";
  kpi.topMeta.textContent = top ? money(top.total) : "";

  renderTrend(monthRows.rows, summary.month);
  renderCategories(cats, summary, catsMeta, monthLabel, 5);
  renderRecent();
}

function renderDelta(current, prev) {
  if (typeof prev !== "number" || prev <= 0) {
    return `<span class="delta delta--flat">No prior month</span>`;
  }
  const pct = ((current - prev) / prev) * 100;
  if (Math.abs(pct) < 0.05) return `<span class="delta delta--flat">Flat vs last month</span>`;
  const up = pct > 0;
  return `<span class="delta ${up ? "delta--up" : "delta--down"}">${up ? "↑" : "↓"} ${Math.abs(pct).toFixed(1)}% vs last month</span>`;
}

/**
 * Daily spend for the month, drawn as an SVG area + line. The API has no daily
 * aggregation endpoint, so this sums the month's real rows in the browser.
 */
function renderTrend(rows, month) {
  const days = daysInMonth(month);
  const totals = new Array(days).fill(0);

  for (const r of rows) {
    const day = Number(String(r.date).slice(8, 10));
    if (day >= 1 && day <= days) totals[day - 1] += Number(r.amount) || 0;
  }

  const peak = Math.max(...totals);
  if (peak <= 0) {
    trendSub.textContent = fmtMonth(month);
    trendPeak.textContent = "";
    trendTip.hidden = true;
    trend.innerHTML = `
      <div class="state">
        <div class="state-title">Nothing recorded in ${escapeHtml(fmtMonth(month))}</div>
        <div class="state-detail">Pick another month, or add an expense.</div>
      </div>`;
    return;
  }

  const W = 640, H = 250, padL = 46, padR = 10, padT = 12, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  // Round the axis ceiling up so gridlines land on readable numbers.
  const step = Math.pow(10, Math.floor(Math.log10(peak)));
  const ceiling = Math.ceil(peak / step) * step;

  const x = (i) => padL + (days === 1 ? innerW / 2 : (i / (days - 1)) * innerW);
  const y = (v) => padT + innerH - (v / ceiling) * innerH;

  const points = totals.map((v, i) => [x(i), y(v)]);
  const line = points.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const area = `${line} L${x(days - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z`;

  // Path length for the draw-in animation, measured off the points we already have.
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }

  const ticks = [0, 0.5, 1].map((f) => {
    const value = ceiling * f;
    const py = y(value);
    return `<line class="grid-line" x1="${padL}" y1="${py.toFixed(1)}" x2="${W - padR}" y2="${py.toFixed(1)}"/>
            <text class="axis-label" x="${padL - 8}" y="${(py + 3.5).toFixed(1)}" text-anchor="end">${shortMoney(value)}</text>`;
  }).join("");

  // Week markers rather than 31 day labels.
  const weeks = [];
  for (let d = 0; d < days; d += 7) {
    weeks.push(`<text class="axis-label" x="${x(d).toFixed(1)}" y="${H - 6}" text-anchor="middle">Week ${weeks.length + 1}</text>`);
  }

  const peakIndex = totals.indexOf(peak);

  trendSub.textContent = `Daily spend across ${fmtMonth(month)}`;
  trendPeak.textContent = `Peak ${money(peak)} on ${fmtDate(dayISO(month, peakIndex))}`;

  trend.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" aria-label="Daily spending for ${escapeHtml(fmtMonth(month))}">
      <defs>
        <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${ticks}
      <path class="trend-area" d="${area}" fill="url(#trendFill)"/>
      <path class="trend-line" style="--len:${len.toFixed(0)}px" d="${line}"/>
      <line class="trend-guide" x1="0" y1="${padT}" x2="0" y2="${padT + innerH}" opacity="0"/>
      <circle class="trend-dot" cx="${x(peakIndex).toFixed(1)}" cy="${y(peak).toFixed(1)}" r="3.5"/>
      <circle class="trend-hover" cx="0" cy="0" r="4.5" opacity="0"/>
      <rect class="trend-hit" x="${padL}" y="${padT}" width="${innerW}" height="${innerH}"/>
      ${weeks.join("")}
    </svg>`;

  attachTrendHover({ totals, days, month, W, padL, innerW, x, y });
}

/** Nearest-day hover readout: exact date, exact amount, highlighted point. */
function attachTrendHover(g) {
  const svg = trend.querySelector("svg");
  const guide = svg.querySelector(".trend-guide");
  const dot = svg.querySelector(".trend-hover");

  const move = (event) => {
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / g.W;
    const vx = (event.clientX - rect.left) / scale;

    const ratio = g.days === 1 ? 0 : (vx - g.padL) / g.innerW;
    const i = Math.min(g.days - 1, Math.max(0, Math.round(ratio * (g.days - 1))));
    const value = g.totals[i];

    const cx = g.x(i);
    const cy = g.y(value);

    guide.setAttribute("x1", cx.toFixed(1));
    guide.setAttribute("x2", cx.toFixed(1));
    guide.setAttribute("opacity", "1");
    dot.setAttribute("cx", cx.toFixed(1));
    dot.setAttribute("cy", cy.toFixed(1));
    dot.setAttribute("opacity", "1");

    trendTipDate.textContent = fmtDate(dayISO(g.month, i));
    trendTipValue.textContent = value > 0 ? money(value) : "No spending";

    trendTip.hidden = false;
    // Keep the bubble inside the card on the first and last days.
    const half = trendTip.offsetWidth / 2;
    const left = Math.min(Math.max(cx * scale, half), rect.width - half);
    trendTip.style.left = `${left}px`;
    trendTip.style.top = `${cy * scale}px`;
  };

  const leave = () => {
    trendTip.hidden = true;
    guide.setAttribute("opacity", "0");
    dot.setAttribute("opacity", "0");
  };

  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerleave", leave);
}

function renderCategories(target, summary, metaEl, monthLabel, limit = Infinity) {
  const list = summary.by_category.slice(0, limit);

  if (list.length === 0) {
    if (metaEl) metaEl.textContent = "";
    target.innerHTML = `<div class="state"><div class="state-detail">No categories to show for ${escapeHtml(monthLabel)}.</div></div>`;
    return;
  }

  const n = summary.by_category.length;
  if (metaEl) {
    metaEl.textContent = list.length < n
      ? `Top ${list.length} of ${n}`
      : `${n} categor${n === 1 ? "y" : "ies"}`;
  }

  const max = Math.max(...list.map((c) => c.total));

  target.innerHTML = list.map((c) => {
    const blank = !c.category;
    const share = summary.total > 0 ? (c.total / summary.total) * 100 : 0;
    const width = max > 0 ? Math.max((c.total / max) * 100, 2) : 0;
    return `
      <div class="cat ${toneClass(c.category)}">
        <div class="cat__name ${blank ? "cat__name--blank" : ""}">
          <span class="dot"></span><span>${escapeHtml(label(c.category))}</span>
        </div>
        <div class="cat__amount">${money(c.total)}</div>
        <div class="cat__track"><div class="cat__fill" style="width:${width.toFixed(1)}%"></div></div>
        <div class="cat__pct">${share.toFixed(share < 10 ? 1 : 0)}%</div>
      </div>`;
  }).join("");
}

async function renderRecent() {
  try {
    const params = new URLSearchParams({ page: 1, page_size: RECENT_SIZE, sort: "date", order: "desc" });
    const { rows } = await listExpenses(params);

    if (rows.length === 0) {
      recent.innerHTML = `<li class="state"><div class="state-detail">No expenses recorded yet.</div></li>`;
      return;
    }

    recent.innerHTML = rows.map((r) => `
      <li class="feed__row ${toneClass(r.category)}">
        <span class="avatar" aria-hidden="true">
          <svg viewBox="0 0 20 20">
            <path d="M5 3.6h10v12.8l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
            <path d="M7.6 7.2h4.8M7.6 10.2h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
        </span>
        <span class="feed__body">
          <span class="feed__title">${escapeHtml(r.title || "")}</span>
          <span class="feed__meta">${fmtDate(r.date)} · ${escapeHtml(label(r.category))}</span>
        </span>
        <span class="feed__amount">${money(r.amount)}</span>
      </li>`).join("");
  } catch (err) {
    recent.innerHTML = `<li class="state"><div class="state-detail">Couldn't load recent expenses.</div></li>`;
  }
}

// ─── Analytics ────────────────────────────────────────────────────────────
async function loadAnalytics() {
  const month = summaryMonth.value || currentMonthISO();
  months.innerHTML = `<span class="skeleton skeleton--block"></span>`;
  catsDetail.innerHTML = Array.from({ length: 6 }, () =>
    `<div class="cat">${skelLine("55%", "skeleton--sm")}${skelLine("60px", "skeleton--sm")}</div>`).join("");

  const wanted = Array.from({ length: 6 }, (_, i) => shiftMonth(month, 5 - i));

  let series;
  let summary;
  try {
    [series, summary] = await Promise.all([
      Promise.all(wanted.map((m) =>
        api(`/summary?month=${encodeURIComponent(m)}`)
          .then((r) => r.json())
          .then((d) => ({ month: m, total: Number(d.total) || 0 })))),
      api(`/summary?month=${encodeURIComponent(month)}`).then((r) => r.json()),
    ]);
  } catch (err) {
    showError(err.friendly || "We couldn't load the analytics.");
    months.innerHTML = "";
    catsDetail.innerHTML = "";
    return;
  }

  renderMonthBars(series, month);
  detailMeta.textContent = fmtMonth(month);
  renderCategories(catsDetail, summary, null, fmtMonth(month));
}

function renderMonthBars(series, activeMonth) {
  const peak = Math.max(...series.map((s) => s.total));
  if (peak <= 0) {
    months.innerHTML = `<div class="state"><div class="state-detail">No spending recorded in this six-month window.</div></div>`;
    return;
  }

  const W = 1120, H = 300, padL = 56, padR = 12, padT = 14, padB = 30;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const step = Math.pow(10, Math.floor(Math.log10(peak)));
  const ceiling = Math.ceil(peak / step) * step;

  const slot = innerW / series.length;
  const barW = Math.min(slot * 0.52, 46);

  const ticks = [0, 0.5, 1].map((f) => {
    const value = ceiling * f;
    const py = padT + innerH - (value / ceiling) * innerH;
    return `<line class="grid-line" x1="${padL}" y1="${py.toFixed(1)}" x2="${W - padR}" y2="${py.toFixed(1)}"/>
            <text class="axis-label" x="${padL - 8}" y="${(py + 3.5).toFixed(1)}" text-anchor="end">${shortMoney(value)}</text>`;
  }).join("");

  const bars = series.map((s, i) => {
    const cx = padL + slot * i + slot / 2;
    const h = (s.total / ceiling) * innerH;
    const py = padT + innerH - h;
    const on = s.month === activeMonth ? " bar--on" : "";
    return `
      <g class="bar-group">
        <rect class="bar${on}" x="${(cx - barW / 2).toFixed(1)}" y="${py.toFixed(1)}"
              width="${barW.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="5">
          <title>${escapeHtml(fmtMonth(s.month))}: ${money(s.total)}</title>
        </rect>
        <text class="axis-label" x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle">${escapeHtml(fmtMonthShort(s.month))}</text>
      </g>`;
  }).join("");

  months.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly spending totals">
      ${ticks}${bars}
    </svg>`;
}

// ─── Expenses list ────────────────────────────────────────────────────────
function buildQuery() {
  const params = new URLSearchParams({ page: currentPage, page_size: PAGE_SIZE });
  for (const [key, value] of Object.entries(currentFilters)) {
    if (value !== "" && value != null) params.set(key, value);
  }
  return params;
}

const hasNarrowingFilters = () => NARROWING.some((key) => currentFilters[key]);

async function loadExpenses() {
  skeletonRows();
  pagePrev.disabled = pageNext.disabled = true;

  let rows;
  try {
    const res = await listExpenses(buildQuery());
    rows = res.rows;
    totalCount = res.total;
  } catch (err) {
    showError(err.friendly || "We couldn't load your expenses.");
    renderTableState("Couldn't load expenses", "Check the message above, then try again.");
    resultCount.textContent = "";
    pagination.hidden = true;
    return;
  }

  if (!Array.isArray(rows)) {
    showError("The server returned an unexpected shape for GET /expenses.");
    renderTableState("Unexpected response");
    return;
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // A delete can empty the final page — step back instead of showing nothing.
  if (rows.length === 0 && currentPage > totalPages) {
    currentPage = totalPages;
    return loadExpenses();
  }

  if (rows.length === 0) {
    renderTableState(
      "No expenses found",
      hasNarrowingFilters()
        ? "Try changing your filters or add a new expense."
        : "Add your first expense to get started.",
      { action: true },
    );
  } else {
    tbody.innerHTML = rows.map(renderRow).join("");
    for (const btn of tbody.querySelectorAll(".icon-btn")) {
      btn.addEventListener("click", () =>
        deleteExpense(Number(btn.dataset.id), btn.dataset.title, btn.dataset.amount, btn));
    }
  }

  renderPagination(rows.length, totalPages);
}

function renderRow(r) {
  // Blank stays blank in the database; "Uncategorized" is only a label.
  const category = r.category
    ? `<span class="pill ${toneClass(r.category)}">${escapeHtml(r.category)}</span>`
    : `<span class="pill pill--blank">Uncategorized</span>`;

  const notes = r.notes ? `<span class="cell-notes">${escapeHtml(r.notes)}</span>` : "";
  const title = escapeHtml(r.title || "");

  return `
    <tr>
      <td class="cell-date" data-label="Date">${fmtDate(r.date)}</td>
      <td data-label="Description"><span class="cell-title">${title}</span>${notes}</td>
      <td data-label="Category">${category}</td>
      <td class="num cell-amount" data-label="Amount">${money(r.amount)}</td>
      <td class="actions-cell">
        <button type="button" class="icon-btn" data-id="${r.id}" data-title="${title}"
                data-amount="${money(r.amount)}" aria-label="Delete ${title}" title="Delete">
          <svg class="icon" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M4.5 6h11M8 6V4.6h4V6M7 6l.5 9h5l.5-9M9 8.5v4M11 8.5v4"
                  fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </td>
    </tr>`;
}

function renderPagination(rowCount, totalPages) {
  if (totalCount === 0) {
    resultCount.textContent = "No records";
    pagination.hidden = true;
    return;
  }
  pagination.hidden = false;
  const first = (currentPage - 1) * PAGE_SIZE + 1;
  const last = first + rowCount - 1;
  resultCount.textContent = `${num(totalCount)} record${totalCount === 1 ? "" : "s"}`;
  pageInfo.textContent = `${num(first)}–${num(last)} of ${num(totalCount)} · Page ${currentPage} of ${totalPages}`;
  pagePrev.disabled = currentPage <= 1;
  pageNext.disabled = currentPage >= totalPages;
}

// ─── Delete ───────────────────────────────────────────────────────────────
let confirmResolve = null;

function askConfirm(title, amount) {
  $("confirm-text").textContent = `"${title}" (${amount}) will be permanently removed.`;
  confirmModal.hidden = false;
  $("confirm-delete").focus();
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function closeConfirm(answer) {
  confirmModal.hidden = true;
  confirmResolve?.(answer);
  confirmResolve = null;
}

for (const el of confirmModal.querySelectorAll("[data-close-confirm]")) {
  el.addEventListener("click", () => closeConfirm(false));
}

$("confirm-delete").addEventListener("click", () => closeConfirm(true));

async function deleteExpense(id, title, amount, button) {
  if (!(await askConfirm(title, amount))) return;

  const confirmBtn = $("confirm-delete");
  if (button) button.disabled = true;
  confirmBtn.disabled = true;

  try {
    await api(`/expenses/${id}`, { method: "DELETE" });
  } catch (err) {
    showError(err.friendly || "We couldn't delete that expense.");
    toast("Unable to delete the expense", "error");
    if (button) button.disabled = false;
    return;
  } finally {
    confirmBtn.disabled = false;
  }

  clearError();
  toast("Expense deleted successfully");
  await render();
}

// ─── Filters ──────────────────────────────────────────────────────────────
function setFilterPanel(open) {
  filterPanel.hidden = !open;
  filterToggle.setAttribute("aria-expanded", String(open));
  filterToggle.classList.toggle("is-on", open);
}

filterToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  setFilterPanel(filterPanel.hidden);
});

document.addEventListener("click", (e) => {
  if (!filterPanel.hidden && !filterPanel.contains(e.target) && e.target !== filterToggle) {
    setFilterPanel(false);
  }
});

filterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  applyFilters();
  setFilterPanel(false);
});

function applyFilters() {
  const data = Object.fromEntries(new FormData(filterForm));

  currentFilters = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== "" && value != null) currentFilters[key] = value;
  }
  currentFilters.sort ||= DEFAULT_FILTERS.sort;
  currentFilters.order ||= DEFAULT_FILTERS.order;

  const active = NARROWING.filter((key) => currentFilters[key]).length;
  filterCount.textContent = String(active);
  filterCount.hidden = active === 0;

  syncSortButton();
  currentPage = 1;
  clearError();
  loadExpenses().then(() => {
    if (active) toast(`Filters applied · ${active} active`);
  });
}

$("filter-reset").addEventListener("click", () => {
  filterForm.reset();
  currentFilters = { ...DEFAULT_FILTERS };
  filterCount.hidden = true;
  syncSortButton();
  currentPage = 1;
  setFilterPanel(false);
  loadExpenses();
});

function syncSortButton() {
  sortLabel.textContent = `Sort: ${SORT_LABELS[currentFilters.sort] || "Date"}`;
  sortArrow.textContent = currentFilters.order === "asc" ? "↑" : "↓";
}

// Clicking the sort button flips the direction; the field itself lives in the
// filter panel. Both still travel as the documented `sort` / `order` params.
sortBtn.addEventListener("click", () => {
  const next = currentFilters.order === "asc" ? "desc" : "asc";
  currentFilters.order = next;
  filterForm.elements.order.value = next;
  syncSortButton();
  currentPage = 1;
  loadExpenses();
});

pagePrev.addEventListener("click", () => {
  if (currentPage > 1) { currentPage--; loadExpenses(); filterForm.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
});

pageNext.addEventListener("click", () => {
  currentPage++; loadExpenses(); filterForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

// ─── Add expense ──────────────────────────────────────────────────────────
function openAddModal() {
  addError.hidden = true;
  addModal.hidden = false;
  // `form.elements` rather than `form.title` — the latter collides with the
  // native HTMLElement.title property.
  addForm.elements.date.value ||= new Date().toISOString().slice(0, 10);
  addForm.elements.title.focus();
}

function closeAddModal() {
  addModal.hidden = true;
  addForm.reset();
  addError.hidden = true;
}

$("open-add").addEventListener("click", openAddModal);

for (const el of addModal.querySelectorAll("[data-close-modal]")) {
  el.addEventListener("click", closeAddModal);
}

document.addEventListener("keydown", (event) => {
  // Ctrl/Cmd+K jumps to the expense search from anywhere.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    focusSearch();
    return;
  }

  if (event.key !== "Escape") return;
  if (!confirmModal.hidden) closeConfirm(false);
  else if (!addModal.hidden) closeAddModal();
  else if (!filterPanel.hidden) setFilterPanel(false);
});

function focusSearch() {
  const field = filterForm.elements.q;
  const focus = () => { field.focus(); field.select(); };
  if (currentView === "expenses") return focus();
  location.hash = "#/expenses";     // setView runs on hashchange
  setTimeout(focus, 80);
}

// Label the hint for the platform the visitor is actually on.
if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
  $("search-hint").textContent = "⌘ K";
}

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  addError.hidden = true;

  const data = Object.fromEntries(new FormData(addForm));
  const title = (data.title || "").trim();
  const amount = Number(data.amount);

  if (!title) return showFormError("Please enter a description.");
  if (!(amount > 0)) return showFormError("Amount must be greater than zero.");
  if (!data.date) return showFormError("Please pick a date.");

  const payload = { title, amount, date: data.date };
  // Omitted rather than sent empty: the backend stores blank as NULL either
  // way, and omitting is the honest way to say "not provided".
  if (data.category?.trim()) payload.category = data.category.trim();
  if (data.notes?.trim()) payload.notes = data.notes.trim();

  addSubmit.disabled = true;
  addSubmit.textContent = "Adding…";

  try {
    await api("/expenses", { method: "POST", body: JSON.stringify(payload) });
  } catch (err) {
    showFormError(err.friendly || "We couldn't save that expense.");
    return;
  } finally {
    addSubmit.disabled = false;
    addSubmit.textContent = "Add expense";
  }

  closeAddModal();
  clearError();
  toast("Expense added successfully");
  currentPage = 1;
  await render();
});

function showFormError(message) {
  addError.textContent = message;
  addError.hidden = false;
}

// ─── Render + boot ────────────────────────────────────────────────────────
function render() {
  if (currentView === "overview") return loadOverview();
  if (currentView === "analytics") return loadAnalytics();
  return loadExpenses();
}

summaryMonth.addEventListener("change", () => {
  setView(currentView); // refreshes the header copy, then re-renders
});

/**
 * Open on the month of the most recent expense rather than on today. Seeded
 * data can end months ago, and landing on an empty dashboard reads as a broken
 * page. Uses only documented list parameters.
 */
async function pickInitialMonth() {
  try {
    const params = new URLSearchParams({ page: 1, page_size: 1, sort: "date", order: "desc" });
    const { rows } = await listExpenses(params);
    if (rows[0]?.date) return rows[0].date.slice(0, 7);
  } catch {
    /* fall back to today; the summary call will surface any real problem */
  }
  return currentMonthISO();
}

(async function boot() {
  skeletonOverview();
  syncSortButton();
  summaryMonth.value = await pickInitialMonth();
  setView(viewFromHash());
})();
