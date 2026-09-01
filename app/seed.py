"""Load expenses.csv into the database.

Run as `python -m app.seed` (add --reset to reload from scratch). Kept out of
application startup on purpose: seeding is an operator action, not something a
web process should do every time it boots.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
from decimal import Decimal, InvalidOperation
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.database import Base, SessionLocal, engine
from app.models import Expense
from app.services import normalise_category

CSV_PATH = Path(__file__).resolve().parents[1] / "expenses.csv"


def _rows(csv_path: Path) -> list[Expense]:
    with csv_path.open(newline="", encoding="utf-8") as handle:
        expenses = []
        for line_no, row in enumerate(csv.DictReader(handle), start=2):
            try:
                amount = Decimal(row["amount"].strip())
                date = dt.date.fromisoformat(row["date"].strip())
            except (InvalidOperation, ValueError, AttributeError) as exc:
                raise ValueError(f"{csv_path.name}:{line_no} - {exc}") from exc

            expenses.append(
                Expense(
                    # The CSV's own ids are dropped and the database assigns its
                    # own. Forcing them in would leave the Postgres identity
                    # sequence at 1 while rows occupy 1..300, and the very first
                    # POST would fail on a duplicate key.
                    title=row["title"].strip(),
                    amount=amount,
                    category=normalise_category(row.get("category")),
                    date=date,
                    notes=(row.get("notes") or "").strip() or None,
                )
            )
    return expenses


def seed(db: Session, *, reset: bool = False) -> int:
    """Insert the CSV. Returns the number of rows written (0 if it was a no-op)."""
    if reset:
        db.execute(delete(Expense))
        db.commit()
    elif db.scalar(select(func.count()).select_from(Expense)):
        return 0

    expenses = _rows(CSV_PATH)
    db.add_all(expenses)
    db.commit()
    return len(expenses)


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed the expenses table from expenses.csv")
    parser.add_argument("--reset", action="store_true", help="delete existing rows first")
    args = parser.parse_args()

    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        written = seed(db, reset=args.reset)

    if written:
        print(f"Seeded {written} expenses from {CSV_PATH.name}.")
    else:
        print("Table already populated; nothing to do. Re-run with --reset to reload.")


if __name__ == "__main__":
    main()
