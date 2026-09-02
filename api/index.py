"""Vercel serverless entry point.

Vercel's Python runtime looks for a module-level `app` in `api/*.py` and serves
it as an ASGI application. The real application lives in `app/main.py`; this
file only puts the repository root on `sys.path`, because the function is
invoked from a different working directory.

Note: this runtime does not run ASGI lifespan events, so the schema creation and
seeding in `app.main.lifespan` do NOT happen here. The database must already
have its schema — see the deployment section of the README.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402  (import after the path is set up)

__all__ = ["app"]
