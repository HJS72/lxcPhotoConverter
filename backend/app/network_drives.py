from __future__ import annotations

import errno
import shutil
import socket
import subprocess
from datetime import UTC, datetime
from pathlib import Path


class ConnectionCheckResult:
    def __init__(self, connected: bool, status: str, message: str):
        self.connected = connected
        self.status = status
        self.message = message
        self.checked_at = datetime.now(UTC).replace(tzinfo=None)


def validate_smb_path(raw_path: str) -> tuple[bool, str]:
    cleaned = raw_path.strip()
    if not cleaned.startswith("//"):
        return False, "Path must start with //server/share"

    parts = [segment for segment in cleaned[2:].split("/") if segment]
    if len(parts) < 2:
        return False, "Path must include server and share"
    return True, cleaned


def extract_server_share(raw_path: str) -> tuple[str, str]:
    parts = [segment for segment in raw_path[2:].split("/") if segment]
    return parts[0], parts[1]


def check_network_drive(smb_path: str, username: str, password: str, timeout_seconds: float = 5.0) -> ConnectionCheckResult:
    ok, normalized = validate_smb_path(smb_path)
    if not ok:
        return ConnectionCheckResult(False, "invalid", normalized)

    server, share = extract_server_share(normalized)
    try:
        socket.create_connection((server, 445), timeout=timeout_seconds).close()
    except OSError as exc:
        return ConnectionCheckResult(False, "offline", f"TCP 445 unreachable: {exc}")

    smbclient_bin = shutil.which("smbclient")
    if smbclient_bin is None:
        return ConnectionCheckResult(
            False,
            "partial",
            "smbclient not installed; host reachable but auth not verified",
        )

    cmd = [
        smbclient_bin,
        f"//{server}/{share}",
        "-U",
        f"{username}%{password}",
        "-m",
        "SMB3",
        "-c",
        "ls",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_seconds, check=False)
    if result.returncode == 0:
        return ConnectionCheckResult(True, "connected", "Connection successful")

    output = (result.stderr or result.stdout or "Authentication or share access failed").strip()
    return ConnectionCheckResult(False, "auth_failed", output[:500])


def normalize_mount_path(raw_path: str | None) -> str | None:
    if raw_path is None:
        return None
    path = raw_path.strip()
    if not path:
        return None
    return str(Path(path).resolve())


def ensure_mount_path_exists(raw_path: str | None) -> str | None:
    normalized = normalize_mount_path(raw_path)
    if normalized is None:
        return None

    mount_path = Path(normalized)
    if mount_path.exists():
        if not mount_path.is_dir():
            raise NotADirectoryError(f"Path exists but is not a directory: {normalized}")
        return normalized

    try:
        mount_path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        if exc.errno in {errno.EACCES, errno.EPERM}:
            # ponytail: allow config save when runtime user cannot mkdir under root-owned parents;
            # mount/bootstrap step can create/chown path later if needed.
            return normalized
        raise

    return normalized
