# Expense Tracker

A REST API implementing [`contract/openapi.yaml`](contract/openapi.yaml), serving the provided
`ui/` frontend from the same origin.

```bash
docker compose up --build      # then open http://localhost:8000
```

That single command brings up Postgres, applies the schema, loads the 300-row sample
CSV and serves both the API and the dashboard on port 8000.

---

## Tech Stack

| | |
|---|---|
| Language | Python 3.11+ |
| Web | FastAPI 0.141, Uvicorn |
| Data | SQLAlchemy 2.0 (ORM + Core), Postgres 16 via psycopg 3 |
| Validation | Pydantic v2 / pydantic-settings |
| Tests | pytest (23 tests, SQLite-backed) |
| Frontend | Vanilla HTML/CSS/JS — no build step, no dependencies |

---

## Architecture

Three layers, and the boundary between them is the part worth defending:

```
routers/     HTTP only — query params, status codes, response headers
   ↓
services.py  domain policy — blank-category rules, month windows
   ↓
repository.py  SQL — the only module that imports `select`
```

- **Routers own HTTP and nothing else.** They validate what is genuinely a request
  concern (`date_from` after `date_to` is a malformed request, not a domain rule),
  set `X-Total-Count`, and choose status codes.
- **Services own policy.** What "blank category" means, how `YYYY-MM` becomes a date
  range. These rules would survive if the transport changed from REST to a queue.
- **The repository owns SQL.** Keeping it in one place is what makes filtering,
  sorting and pagination testable as a unit, and keeps `getattr`-on-user-input out
  of the route handlers.

For a service this small the services layer is thin, and folding it into the routers
would work today. It earns its place because the blank-category rule has to be applied
identically on three paths — create, filter, aggregate — and duplicating it three times
is exactly how those drift apart.

---

## Project Structure

```
app/
  config.py          settings from the environment
  database.py        engine, session factory, startup readiness check
  models.py          the Expense table
  schemas.py         request/response models, sortable-column enum
  repository.py      data access
  services.py        domain policy
  routers/
    expenses.py      GET/POST/DELETE /expenses
    summary.py       GET /summary
    health.py        GET /health
  seed.py            CSV loader
  main.py            app assembly; UI mounted last
scripts/seed.py      `python scripts/seed.py`
tests/               conftest + 23 tests
ui/                  the provided frontend (see Frontend)
contract/            the OpenAPI contract — the source of truth
Dockerfile
docker-compose.yml
```

---

## Database Schema

```sql
CREATE TABLE expenses (
    id       SERIAL PRIMARY KEY,
    title    VARCHAR(255)  NOT NULL,
    amount   NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    category VARCHAR(64),                    -- NULL = uncategorised
    date     DATE          NOT NULL,
    notes    TEXT
);
CREATE INDEX ix_expenses_date     ON expenses (date);
CREATE INDEX ix_expenses_category ON expenses (category);
```

- **`amount` is `NUMERIC(12,2)`, not `DOUBLE PRECISION`.** `/summary` sums this column;
  binary floats drift once you add a few hundred of them, and money that does not
  reconcile is the one bug an expense tracker cannot have. It is converted to a float
  only at serialisation, because the contract says `type: number` and `ui/app.js`
  type-checks it.
- **`category` is a nullable column, not a foreign key.** The contract passes categories
  as free strings and the UI offers suggestions, not a closed list — so a category is a
  label, not an entity. A lookup table would add a join and a write path the contract
  cannot reach.
- **Indexes on `date` and `category`** — the default sort and the cheapest filter. `q`
  does a `LIKE '%…%'` scan, fine at 300 rows and the first thing to need a trigram
  index at 300k.
- **`CHECK (amount > 0)`** duplicates the Pydantic rule on purpose: validation at the
  edge is for good error messages, the constraint is for the guarantee.

---

## API Endpoints

Everything below `/expenses` and `/summary` is exactly as specified in the contract.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/expenses` | List with filter, sort, pagination. **Total is in the `X-Total-Count` header**; the body is a plain array. |
| `POST` | `/expenses` | `201` with the created row. |
| `DELETE` | `/expenses/{id}` | `204` with no body, `404` if unknown. |
| `GET` | `/summary?month=YYYY-MM` | `{ month, total, by_category[] }`, ordered by spend descending. |
| `GET` | `/health` | **Additive, not in the contract.** `{"status": "ok"}` after a real `SELECT 1`; used by the container health check. |

`GET /expenses` query parameters: `page`, `page_size`, `sort`, `order`, `category`, `q`,
`date_from`, `date_to`, `amount_min`, `amount_max`.

Interactive docs at `/docs` while the app is running.

---

## Local Setup

Mac/Linux, from a clean checkout. One command per step.

```bash
python3 -m venv .venv && source .venv/bin/activate    # Python 3.11+
pip install -r requirements.txt
docker compose up -d db --wait                        # Postgres on :5432
python scripts/seed.py                                # loads expenses.csv
uvicorn app.main:app --reload
```

Open **<http://localhost:8000>**.

No Postgres and no Docker? SQLite needs nothing installed:

```bash
DATABASE_URL="sqlite:///./expenses.db" python scripts/seed.py
DATABASE_URL="sqlite:///./expenses.db" uvicorn app.main:app --reload
```

---

## Environment Variables

Copy `.env.example` to `.env` for local development. `.env` is gitignored and holds no
secrets in this project; the defaults below are what compose uses.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://expenses:expenses@localhost:5432/expenses` | Any SQLAlchemy URL. SQLite is supported and is what the tests use. |
| `SEED_ON_STARTUP` | `false` | Load `expenses.csv` on boot when the table is empty. compose sets `true`. |
| `MAX_PAGE_SIZE` | `200` | Ceiling on `page_size`. |
| `DB_CONNECT_ATTEMPTS` | `15` | Startup retries while waiting for the database. |
| `DB_CONNECT_DELAY_SECONDS` | `1.0` | Delay between those retries. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `expenses` | Credentials compose hands to Postgres. |

The startup wait exists because containers start in any order. If the database never
answers, the process exits with a readable message — with the password redacted — rather
than a driver traceback:

```
RuntimeError: Could not reach the database at
postgresql+psycopg://expenses:***@db:5432/expenses after 15 attempts.
Check that it is running and that DATABASE_URL is correct.
```

---

## Running with Docker

```bash
docker compose up --build
```

Two services: `app` (FastAPI + the UI, port 8000) and `db` (Postgres 16, persistent
named volume `pgdata`). The app waits for the database health check, creates the schema
and seeds `expenses.csv` on first boot, so **<http://localhost:8000> is populated
immediately**.

```bash
docker compose down          # stop, keep the data
docker compose down -v       # stop and drop the volume
docker compose logs -f app   # follow the API logs
```

To reload the sample data inside the running container:

```bash
docker compose exec app python scripts/seed.py --reset
```

---

## Seeding Database

```bash
python scripts/seed.py             # no-op if the table already has rows
python scripts/seed.py --reset     # delete everything, then reload
```

`python -m app.seed` is the same command.

**It cannot create uncontrolled duplicates.** Without `--reset` the loader counts the
table first and returns immediately if anything is there, so running it twice — or a
second container starting — inserts nothing:

```
$ python scripts/seed.py
Seeded 300 expenses from expenses.csv.
$ python scripts/seed.py
Table already populated; nothing to do. Re-run with --reset to reload.
```

The CSV's own `id` column is deliberately **not** carried over. Forcing those ids in
would leave the Postgres identity sequence at 1 while rows occupy 1–300, and the very
first `POST` would fail on a duplicate key. Rows with an unparseable amount or date
abort the load with the offending line number rather than being silently skipped.

---

## Running Tests

```bash
pytest
```

23 tests against a throwaway SQLite file — nothing needs to be running.

The same suite also runs against Postgres, which is what the service actually deploys
on. Point `TEST_DATABASE_URL` at a scratch database:

```bash
docker compose up -d db --wait
createdb -h localhost -U expenses expenses_test          # once
TEST_DATABASE_URL=postgresql+psycopg://expenses:expenses@localhost:5432/expenses_test pytest
```

Tests are deliberately weighted towards what a rewrite could quietly break:

- `X-Total-Count` reports the pre-pagination total
- paging over rows that tie on the sort column loses none of them
- `LIKE` wildcards in `q` are treated literally
- `204` really carries no body, and the id is gone afterwards
- December's month window does not spill into the next year
- every branch of the blank-category decision
- `/health` answers and does not shadow a contract route

Warnings are errors (`pytest.ini`), so a deprecation fails the build instead of
scrolling past. That is how the `HTTP_422_UNPROCESSABLE_ENTITY` rename in the pinned
Starlette was caught.

---

## Frontend

`ui/` ships with the assignment. It is mounted **last** in `main.py`:

```python
app.mount("/", StaticFiles(directory=UI_DIR, html=True), name="ui")
```

Order matters — the catch-all would otherwise swallow `/expenses` and `/summary`. The
path is resolved from the module rather than the working directory, so `uvicorn` started
from anywhere still finds it. Because the UI is same-origin, its relative fetches work
with **no CORS layer at all**.

I reworked its presentation into a dashboard (sidebar, KPI cards, an SVG daily-spend
chart, category breakdown, a filterable table). **No request changed**: the same query
parameters, the same `X-Total-Count` header, the same response shapes. Two numbers the
API has no dedicated endpoint for — the monthly transaction count and the daily trend —
are derived from real rows fetched through the documented `date_from`/`date_to` filters
and aggregated in the browser. Nothing on the page is hardcoded or invented.

---

## Important Design Decisions

**Sync, not async.** Sync SQLAlchemy with `def` handlers, which FastAPI runs in a
threadpool. Async buys throughput when a request mostly waits on I/O it can yield
during; here every request is one or two fast local queries, so the win is small and the
cost is real — async sessions, `await` on every query, and the standing footgun of one
blocking call inside an `async def` stalling the event loop. Swapping later means
changing `database.py` and adding `await` in the repository; the routers and services
would not move.

**`create_all` on startup, not Alembic.** Right for a take-home; wrong the moment the
schema changes under data that matters. Alembic is item 1 on the list below.

**Seeding is not a startup side effect by default.** A web process should not mutate
data every time it boots, and under more than one worker they would race. It is opt-in
via `SEED_ON_STARTUP`, which compose sets so a reviewer gets a populated dashboard from
one command — and it is a no-op when the table already has rows.

**Aggregation happens in SQL.** `/summary` is a `GROUP BY` with `SUM`, and the list
endpoint counts and pages in the database. No endpoint loads the table into Python.

---

## Blank Category Handling

~12 of the seeded rows have an empty `category`. The rule: there is exactly **one**
internal representation of "missing" — `NULL` — and exactly **one** wire representation
— `""`.

- `""`, `"   "` and an omitted field all normalise to `NULL` on write, so the three
  cannot coexist in the column and quietly split a `GROUP BY` in two.
- Reads collapse both with `NULLIF(TRIM(COALESCE(category, '')), '')`, so the rule holds
  even for rows some other writer inserts.
- `ExpenseOut` serialises `NULL` as `""` — what the contract documents ("May be an empty
  string") and what the UI already renders as a blank pill.
- **In `/summary` they are their own bucket with `category: ""`, not dropped.** Dropping
  them would mean `total` no longer equalled the sum of the breakdown, and the headline
  number would silently disagree with its own chart. The backend does not invent a name
  like `"Uncategorised"` that could collide with a real user-typed category — the UI
  supplies that label for display only.
- **`?category=Food` never matches them**, which follows from `NULL` semantics and is
  what a user filtering for Food expects.
- **`?category=__blank__` selects exactly the uncategorised rows.** The contract has no
  flag for this, and a bare `?category=` cannot be told apart from an untouched field in
  the UI's filter form — which submits empty strings for everything you did not fill in.
  So an empty value means "no filter", and a reserved value means "the blank ones". It
  is an addition to the contract rather than a change to it: no conforming client can
  tell the difference.

---

## Ambiguities

| Ambiguity | Resolution |
|---|---|
| No `page_size` ceiling in the contract | Capped at 200. Uncapped, `?page_size=999999` is a one-line way to pull the whole table. |
| `sort` is an open string | Whitelisted to `date`/`amount`/`title`/`category`/`id` as an enum; anything else is a `422`. `getattr(Expense, user_input)` is not something I want in a route. |
| Ties on the sort column | Ordering always falls back to `id`. Without a tiebreaker, rows sharing a date can reorder between pages and a paging client skips records. |
| `/summary` for a month with no spend | `200` with `total: 0` and an empty array. A valid empty result, not a missing resource. |
| Contradictory ranges (`date_from` > `date_to`) | `422`. An empty page would be technically correct but hides a client bug. |
| Money precision on `POST` | More than 2 decimal places is rejected rather than silently rounded — the client should know what got stored. |
| `q` semantics | Case-insensitive substring over `title` + `notes`, with `%` and `_` escaped so searching `50%` means `50%`. |
| Future-dated expenses | Allowed. Scheduling a known upcoming payment is legitimate and the contract does not forbid it. |
| A health endpoint | Added at `/health`. The contract does not mention it, but a container needs something to probe; it is additive and shadows nothing. |

---

## What I Would Improve With More Time

1. **Alembic.** `create_all` cannot alter a live table. The first thing that becomes a
   problem in a real deployment.
2. **`GET /expenses/{id}`.** The contract does not ask for it, but `POST` returning a
   resource with no way to fetch it back is an odd shape.
3. **Keyset pagination.** `OFFSET` degrades on deep pages, and `X-Total-Count` means a
   second `COUNT(*)` over the same filters on every request. Both are invisible at 300
   rows and both bite at scale — a cursor plus a cached or approximate count.
4. **A trigram index for `q`.** `LIKE '%…%'` cannot use a b-tree.
5. **A `/summary` variant with daily buckets.** The dashboard's trend chart currently
   pulls the month's rows and aggregates them in the browser. Correct and honest, but a
   server-side `GROUP BY date` would be one small response instead of up to 200 rows.
6. **Decimal all the way to the wire.** `float` at the JSON boundary is forced by the
   contract's `type: number`. A string-encoded decimal would be more honest but would
   break the shipped UI, so the contract wins.
7. **Property-based tests for the filter matrix.** The combinations of nine query
   parameters exceed what example-based tests cover; Hypothesis would find the gaps
   faster than I would.
8. **Structured JSON logging and request ids**, and a CI job running `pytest` plus
   `ruff` on the pinned versions so the setup above stays true on someone else's machine.

---

## Verification Status

What has actually been run, rather than assumed:

| | |
|---|---|
| Test suite on SQLite | 23 passed |
| Test suite on **PostgreSQL 16.2** | 23 passed (same suite via `TEST_DATABASE_URL`) |
| Cold boot on an empty Postgres | schema created, 300 rows seeded, second boot skipped seeding |
| Every endpoint and filter on Postgres | totals, `X-Total-Count`, status codes and the blank-category bucket all as documented |
| Identity sequence after seeding | `POST` returns ids 301, 302 — no duplicate-key failure |
| Database unavailable | exits with the readable message above, password redacted |
| Frontend | driven in headless Chrome at 1440/1280/1024/768/390 px; no horizontal overflow at any width |
| `docker compose up --build` | **not run** — Docker is not installed on the machine this was written on. The compose file parses, every path it copies exists, and the boot sequence it depends on was verified directly against Postgres. |
