"""Seed entry point: `python scripts/seed.py [--reset]`.

A thin shim so the command works from a clean checkout without needing to know
the package layout. The implementation lives in app/seed.py and is equally
reachable as `python -m app.seed`.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.seed import main  # noqa: E402

if __name__ == "__main__":
    main()
