from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app import services
from app.database import get_db
from app.schemas import SummaryOut

router = APIRouter(tags=["summary"])

# Anchored to real months, so "2026-13" is a 422 from the framework rather than
# a ValueError inside date().
MONTH_PATTERN = r"^\d{4}-(0[1-9]|1[0-2])$"


@router.get("/summary", response_model=SummaryOut)
def monthly_summary(
    month: str = Query(..., pattern=MONTH_PATTERN, examples=["2026-06"]),
    db: Session = Depends(get_db),
):
    return services.monthly_summary(db, month)
