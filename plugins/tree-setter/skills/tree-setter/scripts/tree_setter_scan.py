"""Repo-local wrapper for the Synapse tree-setter scanner."""

from __future__ import annotations

import runpy
import sys
from pathlib import Path


def _find_repo_root() -> Path:
    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents]:
        candidate = parent / "analyzer" / "scripts" / "tree_setter_scan.py"
        if candidate.exists():
            return parent
    raise RuntimeError("Could not find analyzer/scripts/tree_setter_scan.py from plugin wrapper")


def main() -> int:
    root = _find_repo_root()
    script = root / "analyzer" / "scripts" / "tree_setter_scan.py"
    root_s = str(root)
    if root_s not in sys.path:
        sys.path.insert(0, root_s)
    runpy.run_path(str(script), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
