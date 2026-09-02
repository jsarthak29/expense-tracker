"""Test wiring.

Tests run against a throwaway SQLite file by default, so `pytest` needs nothing
running. It has to be a file and not `sqlite://`: an in-memory database is
per-connection, and TestClient dispatches sync endpoints across a threadpool, so
the tables would vanish between request and handler.

Set TEST_DATABASE_URL to run the identical suite against Postgres.
"""

from __future__ import annotations

import datetime as dt
import os
import tempfile
from decimal import Decimal
from pathlib import Path

import pytest

_TMP_DB = Path(tempfile.mkdtemp(prefix="expenses-tests-")) / "test.db"

# SQLite by default so `pytest` needs nothing running. Point TEST_DATABASE_URL at a
# throwaway Postgres to run the same suite against the database we actually deploy on:
#   TEST_DATABASE_URL=postgresql+psycopg://user:pw@localhost:5432/expenses_test pytest
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", f"sqlite:///{_TMP_DB.as_posix()}"
)

from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Expense  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_schema():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def client():
    with TestClient(app) as test_client:
        yield test_client


def make_expense(**overrides) -> Expense:
    defaults = dict(
        title="Lunch at Toit",
        amount=Decimal("1650.71"),
        category="Food",
        date=dt.date(2026, 6, 10),
        notes=None,
    )
    return Expense(**{**defaults, **overrides})


@pytest.fixture()
def seeded() -> list[Expense]:
    """A small, hand-built fixture: two months, four categories, one blank."""
    rows = [
        make_expense(title="Lunch at Toit", amount=Decimal("1650.71"), category="Food",
                     date=dt.date(2026, 6, 10), notes="reimbursable"),
        make_expense(title="Groceries", amount=Decimal("2340.00"), category="Food",
                     date=dt.date(2026, 6, 10), notes=None),
        make_expense(title="Metro card top-up", amount=Decimal("530.60"), category="Transport",
                     date=dt.date(2026, 6, 2), notes=None),
        make_expense(title="Unlabelled cash withdrawal", amount=Decimal("1000.00"), category=None,
                     date=dt.date(2026, 6, 20), notes="atm"),
        make_expense(title="Rent", amount=Decimal("32000.00"), category="Rent",
                     date=dt.date(2026, 5, 1), notes=None),
    ]
    with SessionLocal() as db:
        db.add_all(rows)
        db.commit()
        for row in rows:
            db.refresh(row)
        db.expunge_all()
    return rows
