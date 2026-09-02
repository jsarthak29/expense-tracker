from __future__ import annotations

import logging
import time
from collections.abc import Iterator

from sqlalchemy import create_engine, make_url, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


def _engine_kwargs(url: str) -> dict:
    # SQLite needs its single-connection default relaxed for the threadpool that
    # FastAPI runs sync endpoints in. Postgres needs none of this.
    if url.startswith("sqlite"):
        return {"connect_args": {"check_same_thread": False}}
    return {"pool_pre_ping": True}


engine = create_engine(settings.database_url, future=True, **_engine_kwargs(settings.database_url))

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    """Request-scoped session. One session per request, always closed."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def safe_url() -> str:
    """The database URL with any password removed, for logs and error text."""
    return make_url(settings.database_url).render_as_string(hide_password=True)


def wait_for_db() -> None:
    """Block until the database answers, or fail with something readable.

    Compose starts the app and Postgres together, so the first few connections
    can legitimately fail. What must not happen is the process dying on a raw
    driver traceback that says nothing about what to fix.
    """
    attempts = settings.db_connect_attempts
    last: Exception | None = None

    for attempt in range(1, attempts + 1):
        try:
            with engine.connect() as connection:
                connection.execute(text("SELECT 1"))
            return
        except SQLAlchemyError as exc:
            last = exc
            if attempt < attempts:
                logger.warning("Database not ready (attempt %s/%s), retrying…", attempt, attempts)
                time.sleep(settings.db_connect_delay_seconds)

    raise RuntimeError(
        f"Could not reach the database at {safe_url()} after {attempts} attempts. "
        "Check that it is running and that DATABASE_URL is correct."
    ) from last
