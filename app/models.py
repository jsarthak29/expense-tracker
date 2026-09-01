from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlalchemy import CheckConstraint, Date, Index, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Expense(Base):
    __tablename__ = "expenses"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)

    # Money is NUMERIC, not float: 0.1 + 0.2 must not drift in a spend total.
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)

    # NULL means "uncategorised". The service normalises "" and whitespace to
    # NULL on the way in, so there is exactly one representation of "missing".
    category: Mapped[str | None] = mapped_column(String(64), nullable=True)

    date: Mapped[dt.date] = mapped_column(Date, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_expenses_amount_positive"),
        # The list endpoint's default ordering and its two cheapest filters.
        Index("ix_expenses_date", "date"),
        Index("ix_expenses_category", "category"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Expense id={self.id} {self.date} {self.title!r} {self.amount}>"
