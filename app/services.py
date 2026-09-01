"""Domain policy. Sits between the HTTP routers and the repository."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlalchemy.orm import Session

from app import repository
from app.models import Expense
from app.repository import ExpenseFilters
from app.schemas import CategoryTotal, ExpenseIn, SortField, SortOrder, SummaryOut

# Reserved value for `?category=` that selects the rows with no category.
# The contract leaves no room for a dedicated flag, and a bare `category=`
# is indistinguishable from an untouched form field.
UNCATEGORISED = "__blank__"


def normalise_category(value: str | None) -> str | None:
    """"" and whitespace mean "no category", and NULL is how we store that."""
    if value is None:
        return None
    return value.strip() or None


def build_filters(
    *,
    category: str | None = None,
    q: str | None = None,
    date_from: dt.date | None = None,
    date_to: dt.date | None = None,
    amount_min: Decimal | None = None,
    amount_max: Decimal | None = None,
) -> ExpenseFilters:
    """Apply category policy to raw query params before they hit the database."""
    category = normalise_category(category)
    uncategorised = category is not None and category.lower() == UNCATEGORISED
    return ExpenseFilters(
        category=None if uncategorised else category,
        uncategorised=uncategorised,
        q=q.strip() or None if q else None,
        date_from=date_from,
        date_to=date_to,
        amount_min=amount_min,
        amount_max=amount_max,
    )


def list_expenses(
    db: Session,
    *,
    filters: ExpenseFilters,
    sort: SortField,
    order: SortOrder,
    page: int,
    page_size: int,
) -> tuple[list[Expense], int]:
    return repository.list_expenses(
        db, filters=filters, sort=sort, order=order, page=page, page_size=page_size
    )


def create_expense(db: Session, payload: ExpenseIn) -> Expense:
    expense = Expense(
        title=payload.title,
        amount=payload.amount,
        category=normalise_category(payload.category),
        date=payload.date,
        notes=payload.notes or None,
    )
    return repository.add_expense(db, expense)


def delete_expense(db: Session, expense_id: int) -> bool:
    """Delete by id. Returns False when there was nothing to delete."""
    expense = repository.get_expense(db, expense_id)
    if expense is None:
        return False
    repository.delete_expense(db, expense)
    return True


def month_window(month: str) -> tuple[dt.date, dt.date]:
    """Turn "YYYY-MM" into a half-open [start, end) range.

    Half-open beats BETWEEN here: no leap-year or 30-vs-31 day arithmetic, and
    it stays correct if `date` ever becomes a timestamp.
    """
    year, month_number = (int(part) for part in month.split("-"))
    start = dt.date(year, month_number, 1)
    end = dt.date(year + 1, 1, 1) if month_number == 12 else dt.date(year, month_number + 1, 1)
    return start, end


def monthly_summary(db: Session, month: str) -> SummaryOut:
    start, end = month_window(month)
    rows = repository.totals_by_category(db, start=start, end=end)

    by_category = [
        CategoryTotal(category=category or "", total=float(total))
        for category, total in rows
    ]
    total = sum((Decimal(str(row.total)) for row in by_category), Decimal("0"))

    return SummaryOut(month=month, total=float(total), by_category=by_category)
