"""Domain policy. Sits between the HTTP routers and the repository."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app import repository
from app.models import Expense
from app.repository import ExpenseFilters
from app.schemas import ExpenseIn, SortField, SortOrder


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
        category=payload.category,
        date=payload.date,
        notes=payload.notes or None,
    )
    return repository.add_expense(db, expense)
