# Expense Tracker — Backend Engineering Intern Take-Home

## Product story

You're the first backend engineer on a small team building a personal expense-tracking app. A rough frontend is already in place (see `ui/`). You've been asked to build the backend that the frontend consumes — a clean, maintainable REST API that satisfies the shipped contract.

## What we're evaluating

How you build a real service from a contract — schema, project structure, code organisation, validation, error handling — and the judgment you show along the way. We care much more about *why* you made a choice than the choice itself.

## Effort

**About 3 hours.** We do **not** expect a production-ready application. If you run out of time, prioritise a clean, maintainable implementation over more features. Perfect is not the goal — *thoughtful* is.

## What's in this repo

- **`contract/openapi.yaml`** — the API contract you must implement. This is the ground truth. Endpoints, query params, response shapes, headers — all defined here.
- **`ui/`** — a working vanilla-JS frontend that consumes the API above. **This is your instant feedback loop:** the moment your backend is up and correct, the UI lights up with real data. When it isn't, the UI shows loud, specific errors ("`GET /expenses` — 404 Not Found. Have you implemented this endpoint?").
- **`expenses.csv`** — around 300 sample records covering the last ~6 months. Use it to seed your database however you like — SQL script, small Python loader, whatever fits.

Take a look at the CSV before you start — there's one intentional quirk in the data (see the bottom of this file).

## What you'll build

Implement the endpoints in `contract/openapi.yaml`:

- `GET /expenses` — list, filter, sort, paginate
- `POST /expenses` — create
- `DELETE /expenses/{id}` — delete
- `GET /summary?month=YYYY-MM` — total + per-category breakdown for that month

Read the OpenAPI spec carefully. Some pieces to notice:

- **Pagination metadata lives in the `X-Total-Count` response header**, not in the body. Body is a plain array. This is the REST convention GitHub/GitLab use.
- Query params are `page`, `page_size`, `sort`, `order`, `category`, `q`, `date_from`, `date_to`, `amount_min`, `amount_max`.
- The `/summary` endpoint aggregates spend by category for a single month.

## Running the UI

The UI uses relative URLs, so it expects the backend on the **same origin** — any port is fine. Simplest setup: mount the `ui/` folder as static files in your FastAPI app. **Order matters — the mount must come after every API route**, otherwise it swallows them.

```python
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

app = FastAPI()

# ── all your API routes go here ──
@app.get("/expenses")
async def list_expenses(...): ...

@app.get("/summary")
async def summary(...): ...

# ...

# ── mount the UI LAST, so it doesn't swallow /expenses etc. ──
app.mount("/", StaticFiles(directory="ui", html=True), name="ui")
```

Then `http://localhost:8000/` serves the UI, and `http://localhost:8000/expenses` is your API. No CORS to worry about.

## Design decisions are yours (inside the boundary)

The wire contract is fixed. Everything *inside* the service is your call:

- Database schema and constraints
- Project structure and folder layout
- ORM usage patterns
- Validation strategy
- Where the boundary lives between routes, services, and data access
- Error message shapes (as long as the HTTP status matches the contract)

**We encourage reasonable assumptions — just document them in your README.**

## Constraints

- **Python 3.11+, FastAPI, SQLAlchemy, Postgres 14+.** Sync or async — your call, defend it in the README.
- Include at least one meaningful test. We look for whether you can write a test at all, not for coverage.
- If any part of the contract feels ambiguous, note it in your README and pick a defensible answer. Silence on ambiguity is a red flag.

## Commit hygiene

**Please commit to git as you work — small, focused commits per feature or fix, with meaningful messages.** We look at the git history as part of grading:

- Small, incremental commits with clear messages ("wire GET /expenses filters", "add /summary endpoint", "handle blank category in aggregation") = good signal.
- A single giant "initial commit" that lands everything at once = red flag.

You don't need to over-engineer this. Just work the way you'd work on a real team — commit when a piece works, move to the next piece.

## Submission

Reply with a link to your Git repo. Include a `README.md` at the root of your submission covering:

1. **How to bring the service up** from scratch on a Mac/Linux box (ideally one command per step).
2. **How you structured the project and the data model, and why.**
3. **Ambiguities you flagged and how you resolved them.**
4. **What you'd do differently with more time.**

We'll follow up with a short discussion about your submission after reviewing it.

## What we won't grade on

- Auth. Skip it entirely — no bearer tokens needed.
- Rate-limiting, deployment configuration.
- Whether your Docker setup is "production ready" — a minimal working compose is enough.
- Whether the UI is pretty — it's a fixture, not the product.

**Don't over-invest in scaffolding.** A minimal, defensible setup is fine.

---

## The intentional quirk in `expenses.csv`

~12 records have a blank `category` field. Decide how to handle these in your CRUD, list filters, and summary — and document your choice. Silence on this is a red flag.
