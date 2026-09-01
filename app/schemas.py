from __future__ import annotations

import datetime as dt
from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator

MONEY_SCALE = Decimal("0.01")


class SortField(str, Enum):
    """Columns a client may sort by. Anything else is a 422 rather than a 500."""

    date = "date"
    amount = "amount"
    title = "title"
    category = "category"
    id = "id"


class SortOrder(str, Enum):
    asc = "asc"
    desc = "desc"


class ExpenseIn(BaseModel):
    """Request body for POST /expenses (the contract's ExpenseInput)."""

    title: str = Field(min_length=1, max_length=255)
    amount: Decimal = Field(gt=0, le=Decimal("9999999999.99"))
    category: str | None = Field(default=None, max_length=64)
    date: dt.date
    notes: str | None = None

    @field_validator("title", "category", "notes", mode="before")
    @classmethod
    def _strip(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("amount")
    @classmethod
    def _two_decimal_places(cls, value: Decimal) -> Decimal:
        # Reject rather than silently round: the client should know what got stored.
        if value != value.quantize(MONEY_SCALE):
            raise ValueError("amount supports at most 2 decimal places")
        return value


class ExpenseOut(BaseModel):
    """Response body for a single expense (the contract's Expense)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    # Serialised as a JSON number: the contract says `type: number`, and the UI
    # type-checks it. Decimal only exists in the storage/aggregation layer.
    amount: float
    category: str
    date: dt.date
    notes: str | None = None

    @field_validator("category", mode="before")
    @classmethod
    def _blank_for_missing(cls, value: object) -> object:
        # NULL in the database, "" on the wire - the contract documents an empty
        # string for uncategorised rows, and the UI already renders that as blank.
        return "" if value is None else value


class CategoryTotal(BaseModel):
    category: str
    total: float


class SummaryOut(BaseModel):
    month: str
    total: float
    by_category: list[CategoryTotal]
