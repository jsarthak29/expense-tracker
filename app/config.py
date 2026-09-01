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


settings = Settings()
