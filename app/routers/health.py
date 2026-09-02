from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db

router = APIRouter(tags=["ops"])


@router.get("/health")
def health(db: Session = Depends(get_db)) -> dict[str, str]:
    """Liveness plus a real database round trip, for container health checks.

    Additive: the contract in contract/openapi.yaml is untouched.
    """
    db.execute(text("SELECT 1"))
    return {"status": "ok"}
