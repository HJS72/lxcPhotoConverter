from __future__ import annotations

import errno
import re
import shutil
import socket
import subprocess
import tempfile
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


def _check_mount_rw_access(mount_path: str | None) -> ConnectionCheckResult | None:
    normalized_mount = normalize_mount_path(mount_path)
    if normalized_mount is None:
        return None

    root = Path(normalized_mount)
    if not root.exists() or not root.is_dir():
        return ConnectionCheckResult(False, "mount_unavailable", f"mount_path '{normalized_mount}' is not available")

    try:
        with tempfile.NamedTemporaryFile(prefix=".rw-check-", dir=root, delete=False) as handle:
            handle.write(b"rw-check")
            probe_path = Path(handle.name)
        probe_path.unlink(missing_ok=True)
    except OSError as exc:
        return ConnectionCheckResult(False, "read_only", f"mount_path '{normalized_mount}' is not writable: {exc}")

    return None


def check_network_drive(
    smb_path: str,
    username: str,
    password: str,
    mount_path: str | None = None,
    timeout_seconds: float = 5.0,
) -> ConnectionCheckResult:
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
        mount_issue = _check_mount_rw_access(mount_path)
        if mount_issue is not None:
            return mount_issue
        return ConnectionCheckResult(True, "connected", "Connection successful (rw verified)")

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


def list_smb_top_level_folders(smb_path: str, username: str, password: str, timeout_seconds: float = 60.0) -> list[str]:
    ok, normalized = validate_smb_path(smb_path)
    if not ok:
        return []

    smbclient_bin = shutil.which("smbclient")
    if smbclient_bin is None:
        return []

    cmd = [
        smbclient_bin,
        normalized,
        "-U",
        f"{username}%{password}",
        "-m",
        "SMB3",
        "-c",
        "recurse ON;ls",
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_seconds, check=False)
        if result.returncode != 0 and not result.stdout.strip():
            return []
        raw_output = result.stdout
    except subprocess.TimeoutExpired as exc:
        partial = exc.stdout or ""
        if isinstance(partial, bytes):
            partial = partial.decode("utf-8", errors="ignore")
        if not partial.strip():
            return []
        raw_output = partial

    output = raw_output.replace("\\n", "\n")

    folders: set[str] = set()
    current_prefix = ""
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if line.startswith("\\"):
            current_prefix = line.strip("\\").replace("\\", "/")
            continue

        if not line or line.startswith("blocks of size") or line.startswith("Total number of bytes"):
            continue

        columns = [part.strip() for part in re.split(r"\s{2,}", line) if part.strip()]
        if len(columns) < 2:
            continue

        name, attributes = columns[0], columns[1]
        if name in {".", ".."}:
            continue
        if "D" in attributes:
            relative = name.replace("\\", "/").strip("/")
            if current_prefix:
                relative = f"{current_prefix}/{relative}" if relative else current_prefix

            segments = [segment for segment in relative.split("/") if segment]
            if not segments or any(segment.startswith(".") for segment in segments):
                continue
            folders.add("/".join(segments))

    return sorted(folders)


def list_smb_available_shares(
    server: str,
    username: str,
    password: str,
    timeout_seconds: float = 10.0,
) -> tuple[bool, list[str] | str]:
    cleaned_server = server.strip().lstrip("/")
    if not cleaned_server:
        return False, "Server must not be empty"

    smbclient_bin = shutil.which("smbclient")
    if smbclient_bin is None:
        return False, "smbclient not installed"

    cmd = [
        smbclient_bin,
        "-L",
        f"//{cleaned_server}",
        "-U",
        f"{username}%{password}",
        "-m",
        "SMB3",
        "-g",
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_seconds, check=False)
    except subprocess.TimeoutExpired:
        return False, "Timed out while listing SMB shares"

    if result.returncode != 0:
        output = (result.stderr or result.stdout or "Authentication or share access failed").strip()
        return False, output[:500]

    shares: set[str] = set()
    for line in result.stdout.splitlines():
        if not line.startswith("Disk|"):
            continue
        parts = line.split("|")
        if len(parts) < 2:
            continue
        share = parts[1].strip()
        if not share or share.endswith("$"):
            continue
        shares.add(share)

    return True, sorted(shares)


def count_smb_files_recursive(
    smb_path: str,
    username: str,
    password: str,
    subpath: str = "",
    allowed_extensions: set[str] | None = None,
    recursive: bool = True,
    timeout_seconds: float = 120.0,
) -> int:
    ok, normalized = validate_smb_path(smb_path)
    if not ok:
        return 0

    smbclient_bin = shutil.which("smbclient")
    if smbclient_bin is None:
        return 0

    cleaned_subpath = subpath.strip().strip("/")
    command_parts = ["recurse ON" if recursive else "recurse OFF"]
    if cleaned_subpath:
        escaped_subpath = cleaned_subpath.replace('"', '\\"')
        command_parts.append(f'cd "{escaped_subpath}"')
    command_parts.append("ls")

    cmd = [
        smbclient_bin,
        normalized,
        "-U",
        f"{username}%{password}",
        "-m",
        "SMB3",
        "-c",
        ";".join(command_parts),
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_seconds, check=False)
        if result.returncode != 0 and not result.stdout.strip():
            return 0
        raw_output = result.stdout
    except subprocess.TimeoutExpired as exc:
        partial = exc.stdout or ""
        if isinstance(partial, bytes):
            partial = partial.decode("utf-8", errors="ignore")
        if not partial.strip():
            return 0
        raw_output = partial

    output = raw_output.replace("\\n", "\n")
    total_files = 0
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if (
            not line
            or line.startswith("\\")
            or line.startswith("blocks of size")
            or line.startswith("Total number of bytes")
        ):
            continue

        columns = [part.strip() for part in re.split(r"\s{2,}", line) if part.strip()]
        if len(columns) < 2:
            continue

        name, attributes = columns[0], columns[1]
        if name in {".", ".."}:
            continue
        if "D" in attributes:
            continue
        if allowed_extensions is not None:
            extension = Path(name).suffix.lower()
            if extension not in allowed_extensions:
                continue
        total_files += 1

    return total_files


def mount_network_drive_via_helper(
    smb_path: str,
    mount_path: str,
    username: str,
    password: str,
    timeout_seconds: float = 20.0,
) -> tuple[bool, str]:
    ok, normalized = validate_smb_path(smb_path)
    if not ok:
        return False, normalized

    normalized_mount = normalize_mount_path(mount_path)
    if normalized_mount is None:
        return False, "mount_path is required"

    helper = "/opt/lxc-photo-converter/scripts/mount_network_drive.sh"
    cmd = [
        "sudo",
        "-n",
        helper,
        normalized,
        normalized_mount,
        username,
        password,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_seconds, check=False)
    except FileNotFoundError:
        return False, "sudo not installed or mount helper missing"
    except subprocess.TimeoutExpired:
        return False, "mount command timed out"

    if result.returncode != 0:
        output = (result.stderr or result.stdout or "mount failed").strip()
        if "a password is required" in output.lower():
            return False, "sudoers not configured for mount helper"
        return False, output[:500]

    message = (result.stdout or "mounted").strip()
    return True, message[:500]
