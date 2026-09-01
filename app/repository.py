"""Data access. Everything that knows about SQLAlchemy lives here."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import Select, func, or_, select
from sqlalchemy.orm import Session

from app.models import Expense
from app.schemas import SortField, SortOrder


@dataclass(frozen=True, slots=True)
class ExpenseFilters:
    category: str | None = None
    q: str | None = None
    date_from: dt.date | None = None
    date_to: dt.date | None = None
    amount_min: Decimal | None = None
    amount_max: Decimal | None = None


def _escape_like(term: str) -> str:
    """Neutralise LIKE wildcards so `q=50%` searches for a literal "50%"."""
    return term.replace("\\", "\\\\").replace("%", "\%").replace("_", "\_")


def _apply_filters(stmt: Select, filters: ExpenseFilters) -> Select:
    if filters.category:
        stmt = stmt.where(func.lower(Expense.category) == filters.category.lower())

    if filters.q:
        pattern = f"%{_escape_like(filters.q.lower())}%"
        stmt = stmt.where(
            or_(
                func.lower(Expense.title).like(pattern, escape="\\"),
                func.lower(func.coalesce(Expense.notes, "")).like(pattern, escape="\\"),
            )
        )

    if filters.date_from is not None:
        stmt = stmt.where(Expense.date >= filters.date_from)
    if filters.date_to is not None:
        stmt = stmt.where(Expense.date <= filters.date_to)

    if filters.amount_min is not None:
        stmt = stmt.where(Expense.amount >= filters.amount_min)
    if filters.amount_max is not None:
        stmt = stmt.where(Expense.amount <= filters.amount_max)

    return stmt


def list_expenses(
    db: Session,
    *,
    filters: ExpenseFilters,
    sort: SortField,
    order: SortOrder,
    page: int,
    page_size: int,
) -> tuple[list[Expense], int]:
    """Return one page of expenses plus the total matching the filters."""
    base = _apply_filters(select(Expense), filters)

    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0

    column = getattr(Expense, sort.value)
    direction = (lambda c: c.desc()) if order is SortOrder.desc else (lambda c: c.asc())
    # id is the tiebreaker: without it, rows sharing a date can shuffle between
    # pages and the client silently skips or repeats records.
    stmt = (
        base.order_by(direction(column), direction(Expense.id))
        .offset((page - 1) * page_size)
        .limit(page_size)
    )

    return list(db.scalars(stmt).all()), total


def get_expense(db: Session, expense_id: int) -> Expense | None:
    return db.get(Expense, expense_id)


def add_expense(db: Session, expense: Expense) -> Expense:
    db.add(expense)
    db.commit()
    db.refresh(expense)
    return expense


def delete_expense(db: Session, expense: Expense) -> None:
    db.delete(expense)
    db.commit()


def totals_by_category(
    db: Session, *, start: dt.date, end: dt.date
) -> list[tuple[str | None, Decimal]]:
    """Sum spend per category over [start, end). Aggregated in SQL, not Python."""
    stmt = (
        select(Expense.category, func.sum(Expense.amount))
        .where(Expense.date >= start, Expense.date < end)
        .group_by(Expense.category)
        .order_by(func.sum(Expense.amount).desc())
    )
    return [(category, total) for category, total in db.execute(stmt).all()]
