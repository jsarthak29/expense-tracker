from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.database import Base, engine
from app.routers import expenses, summary


@asynccontextmanager
async def lifespan(app: FastAPI):
    # create_all is enough for a service this size; Alembic is the next step
    # once the schema has to change under live data (see README).
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(title="Expense Tracker API", version="1.0.0", lifespan=lifespan)

app.include_router(expenses.router)
app.include_router(summary.router)

# Mounted LAST and at "/", so it never shadows /expenses or /summary. The path is
# resolved from this file rather than the working directory, so `uvicorn` started
# from anywhere still finds it.
UI_DIR = Path(__file__).resolve().parents[1] / "ui"
app.mount("/", StaticFiles(directory=UI_DIR, html=True), name="ui")
