from __future__ import annotations

import json
import subprocess
from datetime import datetime
from pathlib import Path

TIMESTAMP_KEYS = (
    "DateTimeOriginal",
    "CreateDate",
    "MediaCreateDate",
    "FileCreateDate",
)

_TIMESTAMP_FORMATS = (
    "%Y:%m:%d %H:%M:%S",
    "%Y:%m:%d %H:%M:%S%z",
    "%Y-%m-%d %H:%M:%S",
)


def read_metadata(path: Path, exiftool_path: str = "exiftool") -> dict[str, str]:
    cmd = [exiftool_path, "-j", "-n", str(path)]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Failed to run exiftool")

    data = json.loads(result.stdout)
    if not data:
        return {}
    first = data[0]
    return {str(key): str(value) for key, value in first.items()}


def extract_capture_time(metadata: dict[str, str]) -> datetime | None:
    for key in TIMESTAMP_KEYS:
        raw = metadata.get(key)
        if not raw:
            continue
        sanitized = raw.replace("T", " ").replace("Z", "+0000")
        for fmt in _TIMESTAMP_FORMATS:
            try:
                return datetime.strptime(sanitized, fmt)
            except ValueError:
                continue
    return None
