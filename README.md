# Expense Tracker API

FastAPI + SQLAlchemy + Postgres implementation of `contract/openapi.yaml`, serving
the provided `ui/` fixture from the same origin.

---

## 1. Running it

Mac/Linux, from a clean checkout. One command per step.

```bash
python3 -m venv .venv && source .venv/bin/activate   # Python 3.11+
pip install -r requirements.txt
docker compose up -d --wait                          # Postgres 16 on :5432
python -m app.seed                                   # loads expenses.csv (~300 rows)
uvicorn app.main:app --reload
```

Then open **<http://localhost:8000>** — the UI is served by the same process, so
its relative fetches hit the API with no CORS layer involved.

The default `DATABASE_URL` already points at the compose database, so a `.env` is
optional. `.env.example` shows the two shapes:

```bash
DATABASE_URL=postgresql+psycopg://expenses:expenses@localhost:5432/expenses   # default
DATABASE_URL=sqlite:///./expenses.db                                          # no Docker needed
```

Re-seed at any time with `python -m app.seed --reset`.

### Tests

```bash
pytest
```

21 tests, all against a throwaway SQLite file — nothing needs to be running.

---

## 2. Structure and data model

### Layout

```
app/
  config.py          # settings from the environment
  database.py        # engine, session factory, request-scoped get_db
  models.py          # the Expense table
  schemas.py         # request/response models, sort whitelist
  repository.py      # data access — the only module that writes SQL
  services.py        # domain policy — category rules, month windows
  routers/
    expenses.py      # GET/POST/DELETE /expenses
    summary.py       # GET /summary
  seed.py            # `python -m app.seed`
  main.py            # app assembly; UI mounted last
tests/
```

Three layers, and the boundary between them is the part worth defending:

- **Routers own HTTP and nothing else.** Query params, status codes, response
  headers, and request-level validation that is genuinely about the request
  (`date_from` after `date_to` is a malformed request, not a domain rule).
- **Services own policy.** What "blank category" means, how a `YYYY-MM` string
  becomes a date range. These are the rules that would survive if the transport
  changed from REST to a queue consumer.
- **The repository owns SQL.** It is the only place that imports `select`. That
  is what makes the filter, sort and pagination logic testable as one thing and
  keeps `getattr`-on-user-input out of the route handlers.

For a service this small the services layer is thin, and collapsing it into the
routers would work fine today. It earns its place because the blank-category
rule has to be applied identically on three different paths — create, filter and
aggregate — and duplicating it three times is exactly how those drift apart.

### Data model

```sql
CREATE TABLE expenses (
    id       SERIAL PRIMARY KEY,
    title    VARCHAR(255) NOT NULL,
    amount   NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    category VARCHAR(64),                    -- NULL = uncategorised
    date     DATE NOT NULL,
    notes    TEXT
);
CREATE INDEX ix_expenses_date ON expenses (date);
CREATE INDEX ix_expenses_category ON expenses (category);
```

- **`amount` is `NUMERIC(12,2)`, not `DOUBLE PRECISION`.** `/summary` sums this
  column; binary floats drift when you add a few hundred of them, and money
  that does not reconcile is the one bug an expense tracker cannot have. It is
  converted to a float only at serialisation, because the contract says
  `type: number` and `ui/app.js` does `typeof data.total !== "number"`.
- **`category` is a nullable column, not a foreign key to a `categories`
  table.** The contract passes categories as free strings and the UI offers a
  `<datalist>` of suggestions, not a closed `<select>` — so categories are a
  label, not an entity. A lookup table would add a join and a write path the
  contract has no way to reach.
- **Indexes on `date` and `category`** — the default sort and the cheapest
  filter. `q` does a `LIKE '%…%'` scan, which is fine at 300 rows and is the
  first thing that would need a trigram index at 300k.
- **`CHECK (amount > 0)`** duplicates the Pydantic rule on purpose. Validation
  at the edge is for good error messages; the constraint is for the guarantee.

### Sync, not async

Sync SQLAlchemy with `def` handlers, which FastAPI runs in a threadpool.

Async buys throughput when a request is mostly waiting on I/O it can yield
during. Here every request is one or two fast local queries, so the win is
small — and the cost is real: `asyncpg`/`psycopg` async sessions, an async
`sessionmaker`, `await` on every query, and the ever-present footgun of one
blocking call inside an `async def` stalling the whole event loop. At this
scale the threadpool is the boring, correct choice. Swapping later means
changing `database.py` and adding `await` in the repository; the routers and
services would not move.

### Schema creation

`Base.metadata.create_all()` on startup. Right for a take-home; wrong the moment
the schema has to change under data that matters. Alembic is item 1 on the list
below.

---

## 3. Ambiguities in the contract, and how I resolved them

**The blank categories.** ~12 seeded rows have an empty `category`. My rule:
there is exactly **one** internal representation of "missing" — `NULL` — and
exactly **one** wire representation — `""`.

- `""`, `"   "` and an omitted field all normalise to `NULL` on write, so the
  three cannot coexist in the column and quietly split a group-by in two.
- Reads collapse both with `NULLIF(TRIM(COALESCE(category, '')), '')`, so the
  rule holds even for rows some other writer inserts.
- `ExpenseOut` serialises `NULL` as `""`, which is what the contract documents
  ("May be an empty string") and what `ui/app.js` already renders as a `—
  blank —` pill.
- **In `/summary` they are their own bucket with `category: ""`, not dropped.**
  Dropping them would mean `total` no longer equalled the sum of the breakdown,
  and the UI's headline number would silently disagree with its own chart. The
  UI labels that bucket `(blank)` itself — the backend does not invent a name
  like `"Uncategorised"`, which could collide with a real user-typed category.
- **`?category=Food` never matches them**, which follows from `NULL` semantics
  and is what a user filtering for Food expects.

**How do you then filter *for* the uncategorised rows?** The contract has no
flag for it, and `?category=` (empty) is indistinguishable from an untouched
field in the UI's filter form — which submits empty strings for everything you
did not fill in. So an empty value means "no filter", and the reserved value
**`?category=__blank__`** selects exactly the uncategorised rows. It is an
addition to the contract rather than a change to it: no conforming client can
tell the difference, and the alternative (a separate `uncategorised=true`
param) is a bigger deviation for the same result.

**Other calls I had to make:**

| Ambiguity | Resolution |
|---|---|
| No `page_size` ceiling in the contract | Capped at 200. Uncapped, `?page_size=999999` is a one-line way to pull the whole table. |
| `sort` is an open string | Whitelisted to `date`/`amount`/`title`/`category`/`id`; anything else is a 422. `getattr(Expense, user_input)` is not something I want in a route. |
| Ties on the sort column | Ordering always falls back to `id`. Without a tiebreaker, rows sharing a date can reorder between pages and a paging client skips records. |
| `/summary` for a month with no spend | `200` with `total: 0` and an empty array. It is a valid empty result, not a missing resource. |
| Contradictory ranges (`date_from` > `date_to`) | `422`. An empty page would technically be correct but hides a client bug. |
| Money precision on `POST` | Rejects more than 2 decimal places rather than silently rounding — the client should know what got stored. |
| `q` semantics | Case-insensitive substring over `title` + `notes`, with `%` and `_` escaped so searching `50%` means `50%`. |
| Future-dated expenses | Allowed. Scheduling a known upcoming payment is legitimate, and the contract does not forbid it. |
| CSV `id`s on seed | Not carried over. Forcing them would leave the Postgres identity sequence at 1 while rows occupy 1–300, and the first `POST` would fail on a duplicate key. |

---

## 4. What I would do differently with more time

1. **Alembic.** `create_all` cannot alter a live table. This is the first thing
   that becomes a problem in a real deployment.
2. **A `GET /expenses/{id}`.** The contract does not ask for it, but `POST`
   returning a resource with no way to fetch it back is an odd shape.
3. **Keyset pagination.** `OFFSET` degrades on deep pages, and `X-Total-Count`
   means a second `COUNT(*)` over the same filters on every request. Both are
   invisible at 300 rows and both bite at scale — a cursor plus a cached or
   approximate count would be the fix.
4. **A trigram index for `q`.** `LIKE '%…%'` cannot use a b-tree.
5. **Decimal all the way to the wire.** Today `float` at the JSON boundary is
   forced by the contract's `type: number`. A string-encoded decimal would be
   more honest, but it would break the shipped UI, so the contract wins.
6. **Property-based tests for the filter matrix.** The combinations of nine
   query params are more than the example-based tests cover; Hypothesis would
   find the gaps faster than I would.
7. **Structured logging and a `/health`.** Neither is graded here, and both are
   the first thing anyone asks for once it is deployed.
8. **A CI job** running `pytest` plus `ruff` on the pinned versions, so the
   "one command per step" setup above stays true on someone else's machine.
