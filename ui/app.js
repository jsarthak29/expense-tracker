// Expense Tracker UI — vanilla JS, same-origin fetches against the candidate's backend.
// See ../contract/openapi.yaml for the endpoint contract this file assumes.

const PAGE_SIZE = 20;

// ─── State ────────────────────────────────────────────────────────────────
let currentPage    = 1;
let currentFilters = { sort: "date", order: "desc" };
let chart          = null;

// ─── DOM handles ──────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const errorBanner  = $("error-banner");
const errorText    = $("error-text");
const errorDismiss = $("error-dismiss");
const tbody        = $("expenses-tbody");
const pageInfo     = $("page-info");
const pagePrev     = $("page-prev");
const pageNext     = $("page-next");
const chartMonth   = $("chart-month");
const chartTotal   = $("chart-total");
const filterForm   = $("filter-form");
const filterReset  = $("filter-reset");
const addForm      = $("add-form");

// ─── Fetch wrapper — surfaces every problem loudly ────────────────────────
async function api(path, opts = {}) {
  clearError();
  const method = opts.method || "GET";
  let res;
  try {
    res = await fetch(path, {
      ...opts,
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
    });
  } catch (netErr) {
    showError(`${method} ${path} — cannot reach backend. Is your API running on this host? (${netErr.message})`);
    throw netErr;
  }
  if (!res.ok) {
    let extra = "";
    try {
      const body = await res.text();
      extra = body ? ` — ${body.slice(0, 200)}` : "";
    } catch { /* ignore */ }
    let hint = "";
    if (res.status === 404) hint = ". Have you implemented this endpoint?";
    if (res.status === 405) hint = ". Method mismatch — check the OpenAPI contract.";
    if (res.status === 422) hint = ". Validation failed — check request shape vs. the contract.";
    showError(`${method} ${path} — ${res.status} ${res.statusText}${hint}${extra}`);
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return res;
}

function showError(msg) {
  errorText.textContent = msg;
  errorBanner.hidden = false;
}
function clearError() { errorBanner.hidden = true; }
errorDismiss.addEventListener("click", clearError);

// ─── Formatting helpers ───────────────────────────────────────────────────
const fmtMoney = (n) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n ?? 0);
const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};
const currentMonthISO = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

// ─── Expenses list ────────────────────────────────────────────────────────
async function loadExpenses() {
  const params = new URLSearchParams({
    page: currentPage,
    page_size: PAGE_SIZE,
  });
  for (const [k, v] of Object.entries(currentFilters)) {
    if (v !== "" && v != null) params.set(k, v);
  }

  tbody.innerHTML = `<tr class="placeholder"><td colspan="6">Loading…</td></tr>`;

  let rows, total;
  try {
    const res  = await api(`/expenses?${params}`);
    rows       = await res.json();
    const hdr  = res.headers.get("X-Total-Count");
    total      = hdr != null ? Number(hdr) : (Array.isArray(rows) ? rows.length : 0);
  } catch {
    tbody.innerHTML = `<tr class="placeholder"><td colspan="6">Couldn't load expenses. See error banner above.</td></tr>`;
    pageInfo.textContent = "—";
    pagePrev.disabled = pageNext.disabled = true;
    return;
  }

  if (!Array.isArray(rows)) {
    showError(`GET /expenses returned a non-array body. The contract expects a plain array; total goes in the X-Total-Count header.`);
    tbody.innerHTML = `<tr class="placeholder"><td colspan="6">Unexpected response shape.</td></tr>`;
    return;
  }

  if (rows.length === 0) {
    tbody.innerHTML = `<tr class="placeholder"><td colspan="6">No expenses match these filters.</td></tr>`;
  } else {
    tbody.innerHTML = rows.map(renderRow).join("");
    for (const btn of document.querySelectorAll(".delete-btn")) {
      btn.addEventListener("click", () => deleteExpense(Number(btn.dataset.id)));
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  pageInfo.textContent = `Page ${currentPage} of ${totalPages} — ${total} record${total === 1 ? "" : "s"}`;
  pagePrev.disabled = currentPage <= 1;
  pageNext.disabled = currentPage >= totalPages;
}

function renderRow(r) {
  const cat = r.category
    ? `<span class="category-pill">${escapeHtml(r.category)}</span>`
    : `<span class="category-pill category-blank">— blank —</span>`;
  return `
    <tr>
      <td>${fmtDate(r.date)}</td>
      <td>${escapeHtml(r.title || "")}</td>
      <td>${cat}</td>
      <td class="num">${fmtMoney(r.amount)}</td>
      <td>${escapeHtml(r.notes || "")}</td>
      <td><button type="button" class="delete-btn" title="Delete" data-id="${r.id}">×</button></td>
    </tr>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function deleteExpense(id) {
  if (!confirm(`Delete expense #${id}?`)) return;
  try { await api(`/expenses/${id}`, { method: "DELETE" }); }
  catch { return; }
  await Promise.all([loadExpenses(), loadSummary()]);
}

// ─── Add form ─────────────────────────────────────────────────────────────
addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(addForm));
  data.amount = Number(data.amount);
  // strip empty optionals
  if (!data.notes)    delete data.notes;
  if (!data.category) delete data.category;
  try { await api("/expenses", { method: "POST", body: JSON.stringify(data) }); }
  catch { return; }
  addForm.reset();
  currentPage = 1;
  await Promise.all([loadExpenses(), loadSummary()]);
});

// ─── Filters ──────────────────────────────────────────────────────────────
filterForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(filterForm));
  currentFilters = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== "" && v != null) currentFilters[k] = v;
  }
  if (!currentFilters.sort)  currentFilters.sort  = "date";
  if (!currentFilters.order) currentFilters.order = "desc";
  currentPage = 1;
  loadExpenses();
});

filterReset.addEventListener("click", () => {
  filterForm.reset();
  currentFilters = { sort: "date", order: "desc" };
  currentPage = 1;
  loadExpenses();
});

// ─── Pagination ───────────────────────────────────────────────────────────
pagePrev.addEventListener("click", () => { if (currentPage > 1) { currentPage--; loadExpenses(); } });
pageNext.addEventListener("click", () => { currentPage++; loadExpenses(); });

// ─── Monthly summary + chart ──────────────────────────────────────────────
async function loadSummary() {
  const month = chartMonth.value || currentMonthISO();
  let data;
  try {
    const res = await api(`/summary?month=${encodeURIComponent(month)}`);
    data = await res.json();
  } catch {
    chartTotal.textContent = "—";
    if (chart) { chart.destroy(); chart = null; }
    return;
  }

  if (!data || typeof data.total !== "number" || !Array.isArray(data.by_category)) {
    showError(`GET /summary — unexpected response shape. Expected { month, total, by_category: [{category, total}, ...] }.`);
    return;
  }

  chartTotal.textContent = fmtMoney(data.total);
  const labels = data.by_category.map((c) => c.category || "(blank)");
  const values = data.by_category.map((c) => c.total);

  if (chart) { chart.destroy(); }
  chart = new Chart($("chart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Spend (₹)", data: values,
        backgroundColor: "#2563eb", borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { callback: (v) => "₹" + v.toLocaleString("en-IN") } },
      },
    },
  });
}

chartMonth.value = currentMonthISO();
chartMonth.addEventListener("change", loadSummary);

// ─── Boot ─────────────────────────────────────────────────────────────────
loadExpenses();
loadSummary();
