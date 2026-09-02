from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, read from the environment (or a local .env)."""

    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False, extra="ignore")

    # Any SQLAlchemy URL. Postgres is the target (see docker-compose.yml); SQLite
    # is supported so the service and its tests run with nothing else installed.
    database_url: str = "postgresql+psycopg://expenses:expenses@localhost:5432/expenses"

    # Guard rail on `page_size` so a client cannot ask for the whole table in one hop.
    max_page_size: int = 200

    # How long to wait for the database at startup. Containers start in any
    # order, so the app has to tolerate Postgres not being up yet.
    db_connect_attempts: int = 15
    db_connect_delay_seconds: float = 1.0

    # Load expenses.csv on boot when the table is empty. Off by default: a web
    # process should not mutate data every time it starts, and under more than
    # one worker they would race. docker-compose turns it on so a reviewer gets
    # a populated dashboard from a single `up`.
    seed_on_startup: bool = False


settings = Settings()
