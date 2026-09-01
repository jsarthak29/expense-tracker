from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.database import Base, engine
from app.routers import expenses


@asynccontextmanager
async def lifespan(app: FastAPI):
    # create_all is enough for a service this size; Alembic is the next step
    # once the schema has to change under live data (see README).
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(title="Expense Tracker API", version="1.0.0", lifespan=lifespan)

app.include_router(expenses.router)
