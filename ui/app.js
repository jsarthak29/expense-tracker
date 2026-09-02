// Expense Tracker UI — vanilla JS, same-origin fetches, zero dependencies.
//
// The wire contract is fixed (see ../contract/openapi.yaml). This file only
// decides how the data is presented; every request uses the documented query
// parameters, and the list total always comes from the X-Total-Count header.

const PAGE_SIZE = 20;
const DEFAULT_FILTERS = { sort: "date", order: "desc" };

// Filters that count as "narrowing the list" — drives the toolbar badge.
const NARROWING = ["q", "category", "date_from", "date_to", "amount_min", "amount_max"];

// Reserved value the backend understands for "rows with no category".
const UNCATEGORIZED = "__blank__";

const KNOWN_TONES = new Set([
  "food", "transport", "utilities", "entertainment",
  "shopping", "health", "rent", "travel",
]);

let currentPage = 1;
let currentFilters = { ...DEFAULT_FILTERS };
let totalCount = 0;

// ─── DOM ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const errorBanner = $("error-banner");
const errorText = $("error-text");
const tbody = $("expenses-tbody");
const resultCount = $("result-count");
const pagination = $("pagination");
const pageInfo = $("page-info");
const pagePrev = $("page-prev");
const pageNext = $("page-next");
const summaryMonth = $("summary-month");
const breakdown = $("breakdown");
const breakdownMeta = $("breakdown-meta");
const filterForm = $("filter-form");
const filterAdvanced = $("filter-advanced");
const filterToggle = $("filter-toggle");
const filterCount = $("filter-count");
const addForm = $("add-form");
const addModal = $("add-modal");
const addError = $("add-error");
const addSubmit = $("add-submit");
const confirmModal = $("confirm-modal");
const toasts = $("toasts");

const stat = {
  total: $("stat-total"), totalMeta: $("stat-total-meta"),
  count: $("stat-count"), countMeta: $("stat-count-meta"),
  top: $("stat-top"), topMeta: $("stat-top-meta"),
};

// ─── Formatting ───────────────────────────────────────────────────────────
const moneyFmt = new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR",
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const money = (n) => moneyFmt.format(Number(n) || 0);
const count = (n) => Number(n || 0).toLocaleString("en-IN");

const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
};

const fmtMonth = (ym) => {
  if (!ym) return "";
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
};

const currentMonthISO = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

/** "2026-07" -> { from: "2026-07-01", to: "2026-07-31" } for the list filters. */
function monthRange(ym) {
  const [y, m] = ym.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month
  return { from: `${ym}-01`, to: `${ym}-${String(lastDay).padStart(2, "0")}` };
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Categories are free text, so unknown ones fall back to a neutral tone. */
function toneClass(category) {
  if (!category) return "tone--none";
  const slug = category.trim().toLowerCase();
  return KNOWN_TONES.has(slug) ? `tone--${slug}` : "tone--other";
}

// ─── Feedback ─────────────────────────────────────────────────────────────
function showError(message) {
  errorText.textContent = message;
  errorBanner.hidden = false;
}

const clearError = () => { errorBanner.hidden = true; };

$("error-dismiss").addEventListener("click", clearError);
$("error-retry").addEventListener("click", () => {
  clearError();
  refresh();
});

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
      // FastAPI validation errors: [{ loc: [...], msg: "..." }]
      detail = body.detail
        .map((e) => `${(e.loc || []).slice(1).join(".") || "request"}: ${e.msg}`)
        .join("; ");
    }
  } catch {
    /* not JSON — fall through to a generic message */
  }

  if (detail) return detail;
  if (res.status === 404) return "That record no longer exists.";
  if (res.status === 422) return "Some values were not accepted. Please check the form.";
  if (res.status >= 500) return "The server hit an unexpected error. Please try again.";
  return `The request failed (${res.status} ${res.statusText}).`;
}

// ─── Fetch wrapper ────────────────────────────────────────────────────────
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
    const err = new Error(`${res.status}`);
    err.status = res.status;
    err.friendly = await describeFailure(res);
    throw err;
  }
  return res;
}

// ─── Skeletons ────────────────────────────────────────────────────────────
function skeletonStats() {
  stat.total.innerHTML = `<span class="skeleton skeleton--lg"></span>`;
  stat.count.innerHTML = `<span class="skeleton skeleton--lg"></span>`;
  stat.top.innerHTML = `<span class="skeleton skeleton--lg"></span>`;
  for (const el of [stat.totalMeta, stat.countMeta, stat.topMeta]) {
    el.innerHTML = `<span class="skeleton skeleton--sm"></span>`;
  }
}

function skeletonBreakdown() {
  breakdownMeta.textContent = "";
  breakdown.innerHTML = Array.from({ length: 5 }, () => `
    <div class="bd-row">
      <span class="skeleton skeleton--sm" style="width:70%"></span>
      <span class="skeleton" style="height:8px"></span>
      <span class="skeleton skeleton--sm" style="width:64px"></span>
    </div>`).join("");
}

function skeletonRows() {
  tbody.innerHTML = Array.from({ length: 6 }, () =>
    `<tr class="state-row"><td colspan="5"><span class="skeleton"></span></td></tr>`).join("");
}

function renderState(title, detail, { action = false } = {}) {
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
    const res = await api(`/expenses?${buildQuery()}`);
    rows = await res.json();
    const header = res.headers.get("X-Total-Count");
    totalCount = header != null ? Number(header) : rows.length;
  } catch (err) {
    showError(err.friendly || "We couldn't load your expenses.");
    renderState("Couldn't load expenses", "Check the message above, then try again.");
    resultCount.textContent = "";
    pagination.hidden = true;
    return;
  }

  if (!Array.isArray(rows)) {
    showError("The server returned an unexpected shape for GET /expenses.");
    renderState("Unexpected response");
    return;
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // A delete can empty the final page — step back instead of showing nothing.
  if (rows.length === 0 && currentPage > totalPages) {
    currentPage = totalPages;
    return loadExpenses();
  }

  if (rows.length === 0) {
    renderState(
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
        deleteExpense(Number(btn.dataset.id), btn.dataset.title, btn.dataset.amount));
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
                  fill="none" stroke="currentColor" stroke-width="1.4"
                  stroke-linecap="round" stroke-linejoin="round"/>
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

  resultCount.textContent = `${count(totalCount)} record${totalCount === 1 ? "" : "s"}`;
  pageInfo.textContent = `${count(first)}–${count(last)} of ${count(totalCount)} · Page ${currentPage} of ${totalPages}`;
  pagePrev.disabled = currentPage <= 1;
  pageNext.disabled = currentPage >= totalPages;
}

// ─── Monthly overview ─────────────────────────────────────────────────────
async function loadSummary() {
  const month = summaryMonth.value || currentMonthISO();
  skeletonStats();
  skeletonBreakdown();

  const { from, to } = monthRange(month);

  let data;
  let monthlyCount = null;
  try {
    // Two documented calls: /summary for money, the list header for the count.
    const [summaryRes, countRes] = await Promise.all([
      api(`/summary?month=${encodeURIComponent(month)}`),
      api(`/expenses?page=1&page_size=1&date_from=${from}&date_to=${to}`),
    ]);
    data = await summaryRes.json();
    monthlyCount = Number(countRes.headers.get("X-Total-Count") ?? 0);
  } catch (err) {
    showError(err.friendly || "We couldn't load your monthly summary.");
    for (const el of [stat.total, stat.count, stat.top]) el.textContent = "—";
    for (const el of [stat.totalMeta, stat.countMeta, stat.topMeta]) el.innerHTML = "&nbsp;";
    breakdown.innerHTML = "";
    breakdownMeta.textContent = "";
    return;
  }

  if (!data || typeof data.total !== "number" || !Array.isArray(data.by_category)) {
    showError("The server returned an unexpected shape for GET /summary.");
    return;
  }

  const label = fmtMonth(data.month);

  stat.total.textContent = money(data.total);
  stat.totalMeta.textContent = label;

  stat.count.textContent = count(monthlyCount);
  stat.countMeta.textContent = monthlyCount === 1 ? "transaction this month" : "transactions this month";

  // The backend already orders by_category by spend, descending.
  const top = data.by_category[0];
  if (top) {
    stat.top.textContent = top.category || "Uncategorized";
    stat.topMeta.textContent = money(top.total);
  } else {
    stat.top.textContent = "—";
    stat.topMeta.innerHTML = "&nbsp;";
  }

  renderBreakdown(data, label);
}

function renderBreakdown(data, label) {
  if (data.by_category.length === 0) {
    breakdownMeta.textContent = "";
    breakdown.innerHTML = `
      <div class="state-cell">
        <div class="state-title">Nothing recorded in ${escapeHtml(label)}</div>
        <div class="state-detail">Pick another month, or add an expense.</div>
      </div>`;
    return;
  }

  const n = data.by_category.length;
  breakdownMeta.textContent = `${n} categor${n === 1 ? "y" : "ies"} · ${label}`;

  // Bars scale against the largest category so the shape stays readable even
  // when one category dominates the month.
  const max = Math.max(...data.by_category.map((c) => c.total));

  breakdown.innerHTML = data.by_category.map((c) => {
    const blank = !c.category;
    const width = max > 0 ? Math.max((c.total / max) * 100, 2) : 0;
    const share = data.total > 0 ? Math.round((c.total / data.total) * 100) : 0;
    return `
      <div class="bd-row ${toneClass(c.category)}">
        <div class="bd-name ${blank ? "bd-name--blank" : ""}">${escapeHtml(blank ? "Uncategorized" : c.category)}</div>
        <div class="bd-track"><div class="bd-fill" style="width:${width.toFixed(1)}%"></div></div>
        <div class="bd-figures">
          <span class="bd-value">${money(c.total)}</span>
          <span class="bd-pct">${share}%</span>
        </div>
      </div>`;
  }).join("");
}

summaryMonth.addEventListener("change", loadSummary);

const refresh = () => Promise.all([loadExpenses(), loadSummary()]);

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

async function deleteExpense(id, title, amount) {
  if (!(await askConfirm(title, amount))) return;

  try {
    await api(`/expenses/${id}`, { method: "DELETE" });
  } catch (err) {
    showError(err.friendly || "We couldn't delete that expense.");
    toast("Could not delete the expense", "error");
    return;
  }

  clearError();
  toast("Expense deleted");
  await refresh();
}

// ─── Filters ──────────────────────────────────────────────────────────────
function setAdvancedOpen(open) {
  filterAdvanced.hidden = !open;
  filterToggle.setAttribute("aria-expanded", String(open));
}

filterToggle.addEventListener("click", () => setAdvancedOpen(filterAdvanced.hidden));

filterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  applyFilters();
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

  currentPage = 1;
  clearError();
  loadExpenses();
}

$("filter-reset").addEventListener("click", () => {
  filterForm.reset();
  currentFilters = { ...DEFAULT_FILTERS };
  filterCount.hidden = true;
  currentPage = 1;
  loadExpenses();
});

pagePrev.addEventListener("click", () => {
  if (currentPage > 1) { currentPage--; loadExpenses(); scrollToList(); }
});

pageNext.addEventListener("click", () => {
  currentPage++; loadExpenses(); scrollToList();
});

const scrollToList = () => filterForm.scrollIntoView({ behavior: "smooth", block: "nearest" });

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
  if (event.key !== "Escape") return;
  if (!confirmModal.hidden) closeConfirm(false);
  else if (!addModal.hidden) closeAddModal();
});

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
  toast("Expense added");
  currentPage = 1;
  await refresh();
});

function showFormError(message) {
  addError.textContent = message;
  addError.hidden = false;
}

// ─── Boot ─────────────────────────────────────────────────────────────────

/**
 * Open on the month of the most recent expense rather than on today. Seeded
 * data can end months ago, and landing on an empty chart reads as a broken
 * page. Uses only documented list parameters.
 */
async function pickInitialMonth() {
  try {
    const res = await api("/expenses?page=1&page_size=1&sort=date&order=desc");
    const [newest] = await res.json();
    if (newest?.date) return newest.date.slice(0, 7);
  } catch {
    /* fall back to today; the summary call will surface any real problem */
  }
  return currentMonthISO();
}

(async function boot() {
  skeletonStats();
  skeletonBreakdown();
  skeletonRows();
  summaryMonth.value = await pickInitialMonth();
  await refresh();
})();
