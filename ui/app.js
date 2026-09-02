// Expense Tracker UI — vanilla JS, same-origin fetches, no dependencies.
// The wire contract is fixed: see ../contract/openapi.yaml. This file only
// changes how the data is presented, never what is asked for.

const PAGE_SIZE = 20;

const CATEGORY_FILTERS = ["category", "q", "date_from", "date_to", "amount_min", "amount_max"];
const DEFAULT_FILTERS = { sort: "date", order: "desc" };

// Reserved value the backend understands for "rows with no category".
const UNCATEGORIZED = "__blank__";

let currentPage = 1;
let currentFilters = { ...DEFAULT_FILTERS };
let totalCount = 0;

// ─── DOM ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const errorBanner = $("error-banner");
const errorText = $("error-text");
const tbody = $("expenses-tbody");
const resultCount = $("result-count");
const pageInfo = $("page-info");
const pagePrev = $("page-prev");
const pageNext = $("page-next");
const summaryMonth = $("summary-month");
const summaryTotal = $("summary-total");
const summaryMeta = $("summary-meta");
const breakdown = $("breakdown");
const filterForm = $("filter-form");
const addForm = $("add-form");
const addModal = $("add-modal");
const addError = $("add-error");
const addSubmit = $("add-submit");
const toasts = $("toasts");

// ─── Formatting ───────────────────────────────────────────────────────────
const moneyFmt = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const money = (n) => moneyFmt.format(Number(n) || 0);

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

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ─── Feedback: banner, toasts ─────────────────────────────────────────────
function showError(msg) {
  errorText.textContent = msg;
  errorBanner.hidden = false;
}

function clearError() {
  errorBanner.hidden = true;
}

$("error-dismiss").addEventListener("click", clearError);

function toast(message, kind = "success") {
  const el = document.createElement("div");
  el.className = kind === "error" ? "toast toast--error" : "toast";
  el.innerHTML = `<span class="toast__dot"></span><span></span>`;
  el.lastElementChild.textContent = message;
  toasts.append(el);
  setTimeout(() => el.remove(), 3200);
}

/** Turn a failed response into one readable sentence. */
async function describeFailure(res, method, path) {
  let detail = "";
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") {
      detail = body.detail;
    } else if (Array.isArray(body?.detail)) {
      // FastAPI validation errors: [{loc: [...], msg: "..."}]
      detail = body.detail
        .map((e) => `${(e.loc || []).slice(1).join(".") || "request"}: ${e.msg}`)
        .join("; ");
    }
  } catch {
    /* body was not JSON — fall through to the generic message */
  }

  if (detail) return detail;
  if (res.status === 404) return "That record no longer exists.";
  if (res.status === 422) return "Some values were not accepted. Please check the form.";
  if (res.status >= 500) return "The server hit an unexpected error. Please try again.";
  return `${method} ${path} failed with ${res.status} ${res.statusText}.`;
}

// ─── Fetch wrapper ────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const method = opts.method || "GET";
  let res;
  try {
    res = await fetch(path, {
      ...opts,
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
    });
  } catch (netErr) {
    const err = new Error("Cannot reach the server. Is the API still running?");
    err.friendly = err.message;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText}`);
    err.status = res.status;
    err.friendly = await describeFailure(res, method, path);
    throw err;
  }
  return res;
}

// ─── Table states ─────────────────────────────────────────────────────────
function renderSkeleton() {
  const cell = `<td colspan="5"><span class="skeleton"></span></td>`;
  tbody.innerHTML = Array.from({ length: 6 }, () =>
    `<tr class="skeleton-row state-row">${cell}</tr>`).join("");
}

function renderState(title, detail) {
  tbody.innerHTML = `
    <tr class="state-row">
      <td colspan="5" class="state-cell">
        <div class="state-title">${escapeHtml(title)}</div>
        ${detail ? `<div class="state-detail">${escapeHtml(detail)}</div>` : ""}
      </td>
    </tr>`;
}

// ─── Expenses list ────────────────────────────────────────────────────────
function buildQuery() {
  const params = new URLSearchParams({ page: currentPage, page_size: PAGE_SIZE });
  for (const [key, value] of Object.entries(currentFilters)) {
    if (value !== "" && value != null) params.set(key, value);
  }
  return params;
}

async function loadExpenses() {
  renderSkeleton();
  pagePrev.disabled = pageNext.disabled = true;

  let rows;
  try {
    const res = await api(`/expenses?${buildQuery()}`);
    rows = await res.json();
    const header = res.headers.get("X-Total-Count");
    // The contract puts the total in a header; the body is a plain array.
    totalCount = header != null ? Number(header) : rows.length;
    clearError();
  } catch (err) {
    showError(err.friendly || err.message);
    renderState("Couldn't load expenses", "See the message above, then try again.");
    resultCount.textContent = "";
    pageInfo.textContent = "—";
    return;
  }

  if (!Array.isArray(rows)) {
    showError("The server returned an unexpected shape for GET /expenses.");
    renderState("Unexpected response");
    return;
  }

  // A delete can empty the final page — step back rather than showing nothing.
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  if (rows.length === 0 && currentPage > totalPages) {
    currentPage = totalPages;
    return loadExpenses();
  }

  if (rows.length === 0) {
    renderState(
      hasActiveFilters() ? "No expenses match these filters" : "No expenses yet",
      hasActiveFilters() ? "Try widening the date or amount range." : "Add your first expense to get started.",
    );
  } else {
    tbody.innerHTML = rows.map(renderRow).join("");
    for (const btn of tbody.querySelectorAll(".icon-btn")) {
      btn.addEventListener("click", () => deleteExpense(Number(btn.dataset.id), btn.dataset.title));
    }
  }

  renderPagination(rows.length, totalPages);
}

function hasActiveFilters() {
  return CATEGORY_FILTERS.some((k) => currentFilters[k]);
}

function renderRow(r) {
  // Blank stays blank in the database; "Uncategorized" is a label, nothing more.
  const category = r.category
    ? `<span class="pill">${escapeHtml(r.category)}</span>`
    : `<span class="pill pill--blank">Uncategorized</span>`;

  const notes = r.notes
    ? `<span class="cell-notes">${escapeHtml(r.notes)}</span>`
    : "";

  return `
    <tr>
      <td class="cell-date" data-label="Date">${fmtDate(r.date)}</td>
      <td data-label="Description"><span class="cell-title">${escapeHtml(r.title || "")}</span>${notes}</td>
      <td data-label="Category">${category}</td>
      <td class="num cell-amount" data-label="Amount">${money(r.amount)}</td>
      <td class="actions-cell">
        <button type="button" class="icon-btn" data-id="${r.id}"
                data-title="${escapeHtml(r.title || "")}" title="Delete" aria-label="Delete">&times;</button>
      </td>
    </tr>`;
}

function renderPagination(rowCount, totalPages) {
  if (totalCount === 0) {
    resultCount.textContent = "";
    pageInfo.textContent = "No results";
  } else {
    const first = (currentPage - 1) * PAGE_SIZE + 1;
    const last = first + rowCount - 1;
    resultCount.textContent = `${totalCount.toLocaleString("en-IN")} record${totalCount === 1 ? "" : "s"}`;
    pageInfo.textContent = `Showing ${first}–${last} of ${totalCount.toLocaleString("en-IN")}  ·  Page ${currentPage} of ${totalPages}`;
  }
  pagePrev.disabled = currentPage <= 1;
  pageNext.disabled = currentPage >= totalPages;
}

// ─── Delete ───────────────────────────────────────────────────────────────
async function deleteExpense(id, title) {
  if (!confirm(`Delete "${title}"?\n\nThis cannot be undone.`)) return;

  try {
    await api(`/expenses/${id}`, { method: "DELETE" });
  } catch (err) {
    showError(err.friendly || err.message);
    toast("Could not delete the expense", "error");
    return;
  }

  toast("Expense deleted");
  await Promise.all([loadExpenses(), loadSummary()]);
}

// ─── Filters ──────────────────────────────────────────────────────────────
filterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(filterForm));

  currentFilters = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== "" && value != null) currentFilters[key] = value;
  }
  currentFilters.sort ||= DEFAULT_FILTERS.sort;
  currentFilters.order ||= DEFAULT_FILTERS.order;

  currentPage = 1;
  loadExpenses();
});

$("filter-reset").addEventListener("click", () => {
  filterForm.reset();
  currentFilters = { ...DEFAULT_FILTERS };
  currentPage = 1;
  loadExpenses();
});

pagePrev.addEventListener("click", () => {
  if (currentPage > 1) { currentPage--; loadExpenses(); scrollToTable(); }
});

pageNext.addEventListener("click", () => {
  currentPage++; loadExpenses(); scrollToTable();
});

function scrollToTable() {
  filterForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ─── Monthly summary ──────────────────────────────────────────────────────
async function loadSummary() {
  const month = summaryMonth.value || currentMonthISO();

  let data;
  try {
    const res = await api(`/summary?month=${encodeURIComponent(month)}`);
    data = await res.json();
  } catch (err) {
    showError(err.friendly || err.message);
    summaryTotal.textContent = "—";
    summaryMeta.textContent = "";
    breakdown.innerHTML = "";
    return;
  }

  if (!data || typeof data.total !== "number" || !Array.isArray(data.by_category)) {
    showError("The server returned an unexpected shape for GET /summary.");
    return;
  }

  summaryTotal.textContent = money(data.total);

  if (data.by_category.length === 0) {
    summaryMeta.textContent = `in ${fmtMonth(data.month)}`;
    breakdown.innerHTML = `
      <div class="state-cell">
        <div class="state-title">Nothing recorded in ${escapeHtml(fmtMonth(data.month))}</div>
        <div class="state-detail">Pick another month, or add an expense.</div>
      </div>`;
    return;
  }

  const count = data.by_category.length;
  summaryMeta.textContent = `in ${fmtMonth(data.month)} · across ${count} categor${count === 1 ? "y" : "ies"}`;

  // Bars are scaled against the largest category so the shape stays readable
  // even when one category dominates the month.
  const max = Math.max(...data.by_category.map((c) => c.total));

  breakdown.innerHTML = data.by_category.map((c) => {
    const blank = !c.category;
    const width = max > 0 ? Math.max((c.total / max) * 100, 1.5) : 0;
    const share = data.total > 0 ? Math.round((c.total / data.total) * 100) : 0;
    return `
      <div class="bd-row">
        <div class="bd-name ${blank ? "bd-name--blank" : ""}">${escapeHtml(blank ? "Uncategorized" : c.category)}</div>
        <div class="bd-track">
          <div class="bd-fill ${blank ? "bd-fill--blank" : ""}" style="width: ${width.toFixed(1)}%"></div>
        </div>
        <div class="bd-value">${money(c.total)}<span class="bd-pct">${share}%</span></div>
      </div>`;
  }).join("");
}

summaryMonth.addEventListener("change", loadSummary);

// ─── Add expense modal ────────────────────────────────────────────────────
function openModal() {
  addError.hidden = true;
  addModal.hidden = false;
  // `form.elements` rather than `form.title` — the latter collides with the
  // native HTMLElement.title property.
  addForm.elements.date.value ||= new Date().toISOString().slice(0, 10);
  addForm.elements.title.focus();
}

function closeModal() {
  addModal.hidden = true;
  addForm.reset();
  addError.hidden = true;
}

$("open-add").addEventListener("click", openModal);

for (const el of addModal.querySelectorAll("[data-close-modal]")) {
  el.addEventListener("click", closeModal);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !addModal.hidden) closeModal();
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
  // Omit rather than send empty strings: the backend stores blank as NULL either
  // way, but sending nothing is the honest representation of "not provided".
  if (data.category?.trim()) payload.category = data.category.trim();
  if (data.notes?.trim()) payload.notes = data.notes.trim();

  addSubmit.disabled = true;
  addSubmit.textContent = "Saving…";

  try {
    await api("/expenses", { method: "POST", body: JSON.stringify(payload) });
  } catch (err) {
    showFormError(err.friendly || err.message);
    return;
  } finally {
    addSubmit.disabled = false;
    addSubmit.textContent = "Save expense";
  }

  closeModal();
  toast("Expense added");
  currentPage = 1;
  await Promise.all([loadExpenses(), loadSummary()]);
});

function showFormError(message) {
  addError.textContent = message;
  addError.hidden = false;
}

// ─── Boot ─────────────────────────────────────────────────────────────────

/**
 * Default the month picker to the most recent expense rather than to today.
 * Seeded data can end months ago, and opening on an empty chart reads like a
 * broken page. Uses only documented list parameters.
 */
async function pickInitialMonth() {
  try {
    const res = await api("/expenses?page=1&page_size=1&sort=date&order=desc");
    const [newest] = await res.json();
    if (newest?.date) return newest.date.slice(0, 7);
  } catch {
    /* fall back to today — the summary call will surface any real problem */
  }
  return currentMonthISO();
}

(async function boot() {
  summaryMonth.value = await pickInitialMonth();
  await Promise.all([loadExpenses(), loadSummary()]);
})();
