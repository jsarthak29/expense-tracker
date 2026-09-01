from __future__ import annotations

import datetime as dt
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app import services
from app.config import settings
from app.database import get_db
from app.schemas import ExpenseIn, ExpenseOut, SortField, SortOrder

router = APIRouter(tags=["expenses"])


@router.get("/expenses", response_model=list[ExpenseOut])
def list_expenses(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=settings.max_page_size),
    sort: SortField = SortField.date,
    order: SortOrder = SortOrder.desc,
    category: str | None = None,
    q: str | None = None,
    date_from: dt.date | None = None,
    date_to: dt.date | None = None,
    amount_min: Decimal | None = Query(None, ge=0),
    amount_max: Decimal | None = Query(None, ge=0),
    db: Session = Depends(get_db),
):
    if date_from and date_to and date_from > date_to:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "date_from must not be after date_to"
        )
    if amount_min is not None and amount_max is not None and amount_min > amount_max:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "amount_min must not be greater than amount_max"
        )

    filters = services.build_filters(
        category=category,
        q=q,
        date_from=date_from,
        date_to=date_to,
        amount_min=amount_min,
        amount_max=amount_max,
    )
    items, total = services.list_expenses(
        db, filters=filters, sort=sort, order=order, page=page, page_size=page_size
    )

    # The contract puts the total in a header; the body stays a plain array.
    response.headers["X-Total-Count"] = str(total)
    return items


@router.post("/expenses", response_model=ExpenseOut, status_code=status.HTTP_201_CREATED)
def create_expense(payload: ExpenseIn, db: Session = Depends(get_db)):
    return services.create_expense(db, payload)


@router.delete(
    "/expenses/{expense_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
def delete_expense(expense_id: int, db: Session = Depends(get_db)) -> Response:
    if not services.delete_expense(db, expense_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Expense {expense_id} not found")
    # Returning a bare Response keeps 204 genuinely body-less. Annotating this
    # handler `-> None` instead makes FastAPI build a response model for it and
    # refuse to start ("Status code 204 must not have a response body").
    return Response(status_code=status.HTTP_204_NO_CONTENT)
