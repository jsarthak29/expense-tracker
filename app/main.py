from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import Base, SessionLocal, engine, wait_for_db
from app.routers import expenses, health, summary
from app.seed import seed

logger = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Tolerate Postgres still booting, then fail loudly if it never arrives.
    wait_for_db()
    # create_all is enough for a service this size; Alembic is the next step
    # once the schema has to change under live data (see README).
    Base.metadata.create_all(bind=engine)

    if settings.seed_on_startup:
        with SessionLocal() as db:
            written = seed(db)
        if written:
            logger.info("Seeded %s expenses from the bundled CSV.", written)
        else:
            logger.info("Expenses table already populated; skipped seeding.")

    yield


app = FastAPI(
    title="Expense Tracker API",
    version="1.0.0",
    description="Implements contract/openapi.yaml and serves the ui/ fixture from the same origin.",
    lifespan=lifespan,
)

app.include_router(health.router)
app.include_router(expenses.router)
app.include_router(summary.router)

# Mounted LAST and at "/", so it never shadows /expenses or /summary. The path is
# resolved from this file rather than the working directory, so `uvicorn` started
# from anywhere still finds it.
UI_DIR = Path(__file__).resolve().parents[1] / "ui"
app.mount("/", StaticFiles(directory=UI_DIR, html=True), name="ui")
