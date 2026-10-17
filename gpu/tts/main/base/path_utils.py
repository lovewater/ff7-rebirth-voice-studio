import sys
from pathlib import Path


def project_root() -> Path:
    """Return the repository root (two levels above this file)."""
    return Path(__file__).resolve().parents[2]


def ensure_project_paths() -> None:
    """
    Make sure the repo root and `tts_base` directory are on sys.path so that
    `import indextts` works regardless of the current working directory.
    """
    root = project_root()
    candidates = (root, root / "tts_base")
    for path in candidates:
        if not path.exists():
            continue
        path_str = str(path)
        if path_str not in sys.path:
            sys.path.insert(0, path_str)
