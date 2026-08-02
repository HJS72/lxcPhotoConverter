from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid
from copy import deepcopy
from collections import OrderedDict
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from typing import Callable

from sqlalchemy import delete, desc, select

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.exif import extract_capture_time, read_metadata
from app.models import NetworkDrive, ProcessedMedia, Workflow
from app.network_drives import (
    check_network_drive,
    ensure_mount_path_exists,
    list_smb_available_shares,
    list_smb_top_level_folders,
    mount_network_drive_via_helper,
    validate_smb_path,
)
from app.schemas import (
    FolderAuditRequest,
    FolderAuditResponse,
    FolderDuplicateGroup,
    FolderCheckConfigResponse,
    FolderCheckFileItem,
    FolderCheckScanResponse,
    FolderCheckScanStartResponse,
    FolderCheckScanStatusResponse,
    FolderCheckResolveDuplicateRequest,
    FolderCheckResolveDuplicateResponse,
    FolderCheckSummary,
    HistoryItem,
    NetworkDriveClone,
    NetworkDriveCreate,
    NetworkDriveFolderCheckUpdate,
    NetworkDriveItem,
    NetworkShareDiscoveryRequest,
    NetworkDriveUpdate,
    ScanResponse,
    ScanScheduleResponse,
    ScanScheduleUpdate,
    StatsResetResponse,
    StatusResponse,
    WorkflowSourceStatusItem,
    WorkflowCreate,
    WorkflowItem,
    WorkflowUpdate,
)

router = APIRouter()
logger = logging.getLogger(__name__)

FIXED_NAMING_PATTERN = "IMG_{timestamp}"
FIXED_TIMESTAMP_FORMAT = "%Y%m%d_%H%M%S"
EXPECTED_FILENAME_RE = re.compile(r"^IMG_\d{8}_\d{6}(?:_\d{2})?\.[A-Za-z0-9]+$")
HEIC_EXTENSIONS = {".heic", ".heif"}
CHECKSUM_CACHE_PATH = Path(__file__).resolve().parents[2] / "data" / "folder_audit_checksum_cache.json"
CHECKSUM_CACHE_MAX_ENTRIES = 200_000
FOLDER_CHECK_STATE_PATH = Path(__file__).resolve().parents[2] / "data" / "folder_check_state.json"
FOLDER_CHECK_RESULT_PATH = Path(__file__).resolve().parents[2] / "data" / "folder_check_latest_result.json"
FOLDER_CHECK_IMAGE_EXTENSIONS = {".heic", ".heif", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".dng", ".bmp", ".gif", ".webp"}
FOLDER_CHECK_VALID_EXTENSIONS = {".heic", ".heif", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".dng"}
FOLDER_CHECK_EXIF_REQUIRED_EXTENSIONS = {".heic", ".heif", ".jpg", ".jpeg", ".tif", ".tiff", ".dng"}
MAX_FOLDER_CHECK_FILES = 5000

checksum_cache_lock = Lock()
checksum_cache_loaded = False
checksum_cache_dirty = False
checksum_cache: OrderedDict[str, str] = OrderedDict()

folder_check_job_lock = Lock()
folder_check_job_state: dict[str, object] = {
    "job_id": None,
    "status": "idle",
    "root_path": None,
    "started_at": None,
    "finished_at": None,
    "scanned_directories": 0,
    "scanned_files": 0,
    "max_files": MAX_FOLDER_CHECK_FILES,
    "progress_percent": 0,
    "current_item": None,
    "error_message": None,
    "result": None,
}


def validate_workflow_directory_path(path_value: str, field_name: str, *, must_exist: bool = True) -> str:
    cleaned = path_value.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail=f"{field_name} must not be empty")

    resolved = Path(cleaned).expanduser().resolve(strict=False)
    if resolved.exists() and not resolved.is_dir():
        raise HTTPException(status_code=400, detail=f"{field_name} '{cleaned}' is not a directory")
    if must_exist and not resolved.exists():
        raise HTTPException(status_code=400, detail=f"{field_name} '{cleaned}' does not exist")

    return str(resolved)


def get_scan_schedule_response() -> ScanScheduleResponse:
    from app.main import app_state

    return ScanScheduleResponse(
        enabled=app_state.scheduler.is_enabled(),
        interval_seconds=app_state.scheduler.get_interval_seconds(),
        next_scan_at=app_state.scheduler.get_next_scan_time(),
    )


def normalize_extensions(raw: str | None) -> str | None:
    if raw is None:
        return None
    parts = [item.strip().lower() for item in raw.split(",") if item.strip()]
    if not parts:
        return None
    normalized = [item if item.startswith(".") else f".{item}" for item in parts]
    return ",".join(sorted(set(normalized)))


def compute_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_checksum_cache() -> None:
    global checksum_cache_loaded, checksum_cache

    if checksum_cache_loaded:
        return

    CHECKSUM_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not CHECKSUM_CACHE_PATH.exists():
        checksum_cache = OrderedDict()
        checksum_cache_loaded = True
        return

    try:
        payload = json.loads(CHECKSUM_CACHE_PATH.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            checksum_cache = OrderedDict((str(key), str(value)) for key, value in payload.items())
        else:
            checksum_cache = OrderedDict()
    except (OSError, json.JSONDecodeError):
        checksum_cache = OrderedDict()
    checksum_cache_loaded = True


def _build_cache_key(path: Path, size: int, mtime_ns: int, ctime_ns: int | None) -> str:
    resolved = path.resolve(strict=False)
    return f"{resolved}:{size}:{mtime_ns}:{ctime_ns or 0}"


def _get_cached_checksum(cache_key: str) -> str | None:
    with checksum_cache_lock:
        _load_checksum_cache()
        value = checksum_cache.get(cache_key)
        if value is None:
            return None
        checksum_cache.pop(cache_key, None)
        checksum_cache[cache_key] = value
        return value


def _set_cached_checksum(cache_key: str, checksum: str) -> None:
    global checksum_cache_dirty

    with checksum_cache_lock:
        _load_checksum_cache()
        checksum_cache.pop(cache_key, None)
        checksum_cache[cache_key] = checksum

        while len(checksum_cache) > CHECKSUM_CACHE_MAX_ENTRIES:
            checksum_cache.popitem(last=False)

        checksum_cache_dirty = True


def _persist_checksum_cache() -> None:
    global checksum_cache_dirty

    with checksum_cache_lock:
        _load_checksum_cache()
        if not checksum_cache_dirty:
            return
        CHECKSUM_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        CHECKSUM_CACHE_PATH.write_text(json.dumps(checksum_cache), encoding="utf-8")
        checksum_cache_dirty = False


def _checksum_cache_size() -> int:
    with checksum_cache_lock:
        _load_checksum_cache()
        return len(checksum_cache)


def _load_json_file(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if isinstance(payload, dict):
        return payload
    return {}


def _write_json_file(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=True), encoding="utf-8")


def _get_folder_check_drive(db: Session) -> NetworkDrive | None:
    return db.scalar(select(NetworkDrive).where(NetworkDrive.folder_check_enabled.is_(True)))


def _resolve_under_root(root: Path, relative_path: str) -> Path:
    candidate = (root / relative_path).resolve(strict=False)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Path is outside configured root") from exc
    return candidate


def _folder_check_status_snapshot() -> dict[str, object]:
    with folder_check_job_lock:
        return deepcopy(folder_check_job_state)


def _folder_check_status_response() -> FolderCheckScanStatusResponse:
    snapshot = _folder_check_status_snapshot()
    result_payload = snapshot.get("result")
    parsed_result = None
    if isinstance(result_payload, dict) and result_payload:
        try:
            parsed_result = FolderCheckScanResponse.model_validate(result_payload)
        except Exception:
            parsed_result = None

    return FolderCheckScanStatusResponse(
        job_id=snapshot.get("job_id") if isinstance(snapshot.get("job_id"), str) else None,
        status=str(snapshot.get("status") or "idle"),
        root_path=snapshot.get("root_path") if isinstance(snapshot.get("root_path"), str) else None,
        started_at=snapshot.get("started_at") if isinstance(snapshot.get("started_at"), datetime) else None,
        finished_at=snapshot.get("finished_at") if isinstance(snapshot.get("finished_at"), datetime) else None,
        scanned_directories=int(snapshot.get("scanned_directories") or 0),
        scanned_files=int(snapshot.get("scanned_files") or 0),
        max_files=int(snapshot.get("max_files") or MAX_FOLDER_CHECK_FILES),
        progress_percent=int(snapshot.get("progress_percent") or 0),
        current_item=snapshot.get("current_item") if isinstance(snapshot.get("current_item"), str) else None,
        error_message=snapshot.get("error_message") if isinstance(snapshot.get("error_message"), str) else None,
        result=parsed_result,
    )


def _update_folder_check_job(**changes: object) -> None:
    with folder_check_job_lock:
        folder_check_job_state.update(changes)


def _normalize_folder_check_files(files: list[FolderCheckFileItem]) -> list[FolderCheckFileItem]:
    hash_counts: dict[str, int] = {}
    for item in files:
        if item.sha256:
            hash_counts[item.sha256] = hash_counts.get(item.sha256, 0) + 1

    normalized: list[FolderCheckFileItem] = []
    for item in files:
        duplicate_flag = bool(item.sha256 and hash_counts.get(item.sha256, 0) > 1)
        if duplicate_flag != item.duplicate:
            item = item.model_copy(update={"duplicate": duplicate_flag})
        normalized.append(item)
    return normalized


def _build_folder_check_summary(files: list[FolderCheckFileItem], directories_total: int) -> FolderCheckSummary:
    return FolderCheckSummary(
        files_total=len(files),
        directories_total=directories_total,
        duplicates_total=sum(1 for item in files if item.duplicate),
        wrong_name_total=sum(1 for item in files if item.wrong_name),
        wrong_extension_total=sum(1 for item in files if item.wrong_extension),
        exif_invalid_total=sum(1 for item in files if item.exif_invalid),
        never_scanned_total=sum(1 for item in files if item.never_scanned),
        changed_total=sum(1 for item in files if item.changed_since_last_scan),
    )


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/status", response_model=StatusResponse)
def status() -> StatusResponse:
    from app.main import app_state

    queue_stats = app_state.processor.get_queue_stats()
    db_stats = app_state.processor.get_db_stats()
    workflow_stats = app_state.processor.get_workflow_source_stats()
    last_scan_at, last_scan_discovered, last_scan_queued, last_scan_trigger = app_state.scheduler.get_last_scan_info()
    return StatusResponse(
        queued_files=queue_stats.queued_files,
        workers_alive=queue_stats.workers_alive,
        total_processed=db_stats["total_processed"],
        total_failed=db_stats["total_failed"],
        total_duplicates=db_stats["total_duplicates"],
        next_scan_at=app_state.scheduler.get_next_scan_time(),
        last_scan_at=last_scan_at,
        last_scan_discovered=last_scan_discovered,
        last_scan_queued=last_scan_queued,
        last_scan_trigger=last_scan_trigger,
        scan_interval_seconds=app_state.scheduler.get_interval_seconds(),
        scan_schedule_enabled=app_state.scheduler.is_enabled(),
        workflow_sources=[
            WorkflowSourceStatusItem(
                workflow_id=item.workflow_id,
                workflow_name=item.workflow_name,
                source_path=item.source_path,
                enabled=item.enabled,
                files_total=item.files_total,
                queued_files=item.queued_files,
                processed_files=item.processed_files,
                failed_files=item.failed_files,
                duplicate_files=item.duplicate_files,
            )
            for item in workflow_stats
        ],
    )


@router.get("/history", response_model=list[HistoryItem])
def history(limit: int = 100, db: Session = Depends(get_db)) -> list[HistoryItem]:
    rows = db.scalars(select(ProcessedMedia).order_by(desc(ProcessedMedia.created_at)).limit(limit)).all()
    return [
        HistoryItem(
            id=row.id,
            source_path=row.source_path,
            destination_path=row.destination_path,
            extension=row.extension,
            captured_at=row.captured_at,
            status=row.status,
            error_message=row.error_message,
            created_at=row.created_at,
        )
        for row in rows
    ]


@router.post("/folder-audit", response_model=FolderAuditResponse)
def folder_audit(payload: FolderAuditRequest) -> FolderAuditResponse:
    started_at = time.perf_counter()
    root_path = validate_workflow_directory_path(payload.root_path, "root_path", must_exist=True)
    root = Path(root_path)

    heic_files: list[str] = []
    wrong_name_files: list[str] = []
    scan_errors: list[str] = []
    files_by_size: dict[int, list[Path]] = {}
    file_stats: dict[Path, os.stat_result] = {}
    scanned_folders = 0
    scanned_files = 0
    heic_count = 0
    wrong_name_count = 0
    checksum_cache_hits = 0
    checksum_computed = 0

    def collect_scan_error(error_message: str) -> None:
        if len(scan_errors) < payload.max_results:
            scan_errors.append(error_message)

    for dirpath, _, filenames in os.walk(root, onerror=lambda err: collect_scan_error(str(err))):
        scanned_folders += 1
        current_dir = Path(dirpath)
        for filename in filenames:
            candidate = current_dir / filename
            scanned_files += 1
            relative = candidate.relative_to(root).as_posix()
            extension = candidate.suffix.lower()

            if extension in HEIC_EXTENSIONS:
                heic_count += 1
                if len(heic_files) < payload.max_results:
                    heic_files.append(relative)

            if not EXPECTED_FILENAME_RE.match(candidate.name):
                wrong_name_count += 1
                if len(wrong_name_files) < payload.max_results:
                    wrong_name_files.append(relative)

            try:
                file_stat = candidate.stat()
                size = file_stat.st_size
            except OSError as exc:
                collect_scan_error(f"{relative}: {exc}")
                continue

            file_stats[candidate] = file_stat
            files_by_size.setdefault(size, []).append(candidate)

    duplicate_groups: list[FolderDuplicateGroup] = []
    duplicate_files_count = 0
    duplicate_groups_count = 0

    for size, same_size_files in files_by_size.items():
        if len(same_size_files) < 2:
            continue

        files_by_hash: dict[str, list[Path]] = {}
        for file_path in same_size_files:
            current_stat = file_stats.get(file_path)
            if current_stat is None:
                try:
                    current_stat = file_path.stat()
                except OSError as exc:
                    collect_scan_error(f"{file_path.relative_to(root).as_posix()}: {exc}")
                    continue

            cache_key = _build_cache_key(
                file_path,
                current_stat.st_size,
                current_stat.st_mtime_ns,
                getattr(current_stat, "st_ctime_ns", None),
            )

            cached_hash = _get_cached_checksum(cache_key)
            if cached_hash is not None:
                checksum_cache_hits += 1
                files_by_hash.setdefault(cached_hash, []).append(file_path)
                continue

            try:
                file_hash = compute_sha256(file_path)
            except OSError as exc:
                collect_scan_error(f"{file_path.relative_to(root).as_posix()}: {exc}")
                continue

            checksum_computed += 1
            _set_cached_checksum(cache_key, file_hash)
            files_by_hash.setdefault(file_hash, []).append(file_path)

        for digest, same_hash_files in files_by_hash.items():
            if len(same_hash_files) < 2:
                continue

            duplicate_groups_count += 1
            duplicate_files_count += len(same_hash_files)

            if len(duplicate_groups) >= payload.max_results:
                continue

            duplicate_groups.append(
                FolderDuplicateGroup(
                    sha256=digest,
                    file_count=len(same_hash_files),
                    size_bytes=size,
                    paths=[path.relative_to(root).as_posix() for path in same_hash_files[: payload.max_results]],
                )
            )

    try:
        _persist_checksum_cache()
    except OSError as exc:
        collect_scan_error(f"checksum_cache_write_failed: {exc}")

    duration_ms = int((time.perf_counter() - started_at) * 1000)

    return FolderAuditResponse(
        root_path=str(root),
        scanned_folders=scanned_folders,
        scanned_files=scanned_files,
        duration_ms=duration_ms,
        heic_count=heic_count,
        wrong_name_count=wrong_name_count,
        duplicate_groups_count=duplicate_groups_count,
        duplicate_files_count=duplicate_files_count,
        checksum_cache_hits=checksum_cache_hits,
        checksum_computed=checksum_computed,
        checksum_cache_entries=_checksum_cache_size(),
        heic_files=sorted(heic_files),
        wrong_name_files=sorted(wrong_name_files),
        duplicate_groups=duplicate_groups,
        scan_errors=scan_errors,
    )


@router.get("/folder-check/config", response_model=FolderCheckConfigResponse)
def folder_check_config(db: Session = Depends(get_db)) -> FolderCheckConfigResponse:
    drive = _get_folder_check_drive(db)
    if drive is None:
        return FolderCheckConfigResponse(drive_id=None, drive_name=None, root_path=None)
    return FolderCheckConfigResponse(
        drive_id=drive.id,
        drive_name=drive.name,
        root_path=drive.mount_path,
    )


def _build_folder_check_scan_response(
    root: Path,
    progress_callback: Callable[[int, int, str | None], None] | None = None,
) -> FolderCheckScanResponse:
    started_at = time.perf_counter()
    state = _load_json_file(FOLDER_CHECK_STATE_PATH)
    previous_files = state.get("files") if isinstance(state.get("files"), dict) else {}
    previous_map: dict[str, dict[str, object]] = {
        str(key): value for key, value in previous_files.items() if isinstance(value, dict)
    }

    files: list[FolderCheckFileItem] = []
    scan_errors: list[str] = []
    scanned_directories = 0
    scanned_files_total = 0
    hash_counts: dict[str, int] = {}
    next_state_files: dict[str, dict[str, object]] = {}

    for dirpath, _, filenames in os.walk(root):
        scanned_directories += 1
        if progress_callback is not None:
            progress_callback(scanned_directories, scanned_files_total, Path(dirpath).relative_to(root).as_posix() if Path(dirpath) != root else "")
        current_dir = Path(dirpath)
        for filename in filenames:
            scanned_files_total += 1
            if len(files) >= MAX_FOLDER_CHECK_FILES:
                break

            path = current_dir / filename
            extension = path.suffix.lower()
            if extension not in FOLDER_CHECK_IMAGE_EXTENSIONS:
                continue

            relative = path.relative_to(root).as_posix()
            directory = path.parent.relative_to(root).as_posix() if path.parent != root else ""
            if progress_callback is not None:
                progress_callback(scanned_directories, scanned_files_total, relative)

            try:
                stat = path.stat()
            except OSError as exc:
                if len(scan_errors) < 200:
                    scan_errors.append(f"{relative}: {exc}")
                continue

            previous = previous_map.get(relative, {})
            never_scanned = not bool(previous)
            changed = (
                not never_scanned
                and (
                    int(previous.get("size_bytes", -1)) != stat.st_size
                    or int(previous.get("modified_ns", -1)) != stat.st_mtime_ns
                )
            )

            cache_key = _build_cache_key(path, stat.st_size, stat.st_mtime_ns, getattr(stat, "st_ctime_ns", None))
            file_hash = _get_cached_checksum(cache_key)
            if file_hash is None:
                try:
                    file_hash = compute_sha256(path)
                    _set_cached_checksum(cache_key, file_hash)
                except OSError as exc:
                    file_hash = None
                    if len(scan_errors) < 200:
                        scan_errors.append(f"{relative}: {exc}")

            exif_capture_at: datetime | None = None
            if extension in FOLDER_CHECK_EXIF_REQUIRED_EXTENSIONS:
                should_reuse = (
                    not changed
                    and not never_scanned
                    and isinstance(previous.get("exif_capture_at"), str)
                )
                if should_reuse:
                    try:
                        exif_capture_at = datetime.fromisoformat(str(previous.get("exif_capture_at")))
                    except ValueError:
                        exif_capture_at = None
                else:
                    try:
                        metadata = read_metadata(path, "exiftool")
                        exif_capture_at = extract_capture_time(metadata)
                    except Exception:
                        exif_capture_at = None

            wrong_name = EXPECTED_FILENAME_RE.match(filename) is None
            wrong_extension = extension not in FOLDER_CHECK_VALID_EXTENSIONS
            exif_invalid = extension in FOLDER_CHECK_EXIF_REQUIRED_EXTENSIONS and exif_capture_at is None
            duplicate = file_hash is not None and hash_counts.get(file_hash, 0) >= 1

            if file_hash is not None:
                hash_counts[file_hash] = hash_counts.get(file_hash, 0) + 1

            item = FolderCheckFileItem(
                relative_path=relative,
                directory=directory,
                filename=filename,
                extension=extension,
                size_bytes=stat.st_size,
                modified_at=datetime.fromtimestamp(stat.st_mtime, tz=UTC).replace(tzinfo=None),
                sha256=file_hash,
                duplicate=duplicate,
                wrong_name=wrong_name,
                wrong_extension=wrong_extension,
                exif_invalid=exif_invalid,
                never_scanned=never_scanned,
                changed_since_last_scan=changed,
                exif_capture_at=exif_capture_at,
            )
            files.append(item)

            next_state_files[relative] = {
                "size_bytes": stat.st_size,
                "modified_ns": stat.st_mtime_ns,
                "sha256": file_hash,
                "exif_capture_at": exif_capture_at.isoformat() if exif_capture_at else None,
                "last_scanned_at": datetime.now(UTC).replace(tzinfo=None).isoformat(),
            }

    files = _normalize_folder_check_files(files)
    summary = _build_folder_check_summary(files, scanned_directories)

    response = FolderCheckScanResponse(
        root_path=str(root),
        scanned_at=datetime.now(UTC).replace(tzinfo=None),
        duration_ms=int((time.perf_counter() - started_at) * 1000),
        summary=summary,
        files=files,
        scan_errors=scan_errors,
    )

    try:
        _write_json_file(
            FOLDER_CHECK_STATE_PATH,
            {
                "root_path": str(root),
                "files": next_state_files,
                "updated_at": datetime.now(UTC).replace(tzinfo=None).isoformat(),
            },
        )
        _write_json_file(FOLDER_CHECK_RESULT_PATH, response.model_dump(mode="json"))
        _persist_checksum_cache()
    except OSError as exc:
        logger.warning("Folder check state write failed", extra={"error": str(exc)})

    return response


@router.post("/folder-check/scan", response_model=FolderCheckScanResponse)
def folder_check_scan(db: Session = Depends(get_db)) -> FolderCheckScanResponse:
    drive = _get_folder_check_drive(db)
    if drive is None:
        raise HTTPException(status_code=400, detail="No Folder Check drive selected")
    if not drive.mount_path:
        raise HTTPException(status_code=400, detail="Selected Folder Check drive has no mount_path")

    root = Path(validate_workflow_directory_path(drive.mount_path, "root_path", must_exist=True))
    return _build_folder_check_scan_response(root)


def _run_folder_check_scan_job(job_id: str, root_path: str) -> None:
    root = Path(root_path)

    def progress(scanned_directories: int, scanned_files: int, current_item: str | None) -> None:
        progress_value = 0
        if MAX_FOLDER_CHECK_FILES > 0:
            progress_value = min(99, int((scanned_files / MAX_FOLDER_CHECK_FILES) * 100))
        _update_folder_check_job(
            scanned_directories=scanned_directories,
            scanned_files=scanned_files,
            progress_percent=progress_value,
            current_item=current_item,
        )

    try:
        response = _build_folder_check_scan_response(root, progress_callback=progress)
        _update_folder_check_job(
            status="completed",
            finished_at=datetime.now(UTC).replace(tzinfo=None),
            progress_percent=100,
            current_item=None,
            error_message=None,
            result=response.model_dump(mode="json"),
        )
    except Exception as exc:
        logger.exception("Folder check async scan failed", extra={"status": "failed"})
        _update_folder_check_job(
            status="failed",
            finished_at=datetime.now(UTC).replace(tzinfo=None),
            progress_percent=100,
            current_item=None,
            error_message=str(exc),
        )


@router.post("/folder-check/scan/start", response_model=FolderCheckScanStartResponse)
def start_folder_check_scan(db: Session = Depends(get_db)) -> FolderCheckScanStartResponse:
    drive = _get_folder_check_drive(db)
    if drive is None:
        raise HTTPException(status_code=400, detail="No Folder Check drive selected")
    if not drive.mount_path:
        raise HTTPException(status_code=400, detail="Selected Folder Check drive has no mount_path")

    root_path = validate_workflow_directory_path(drive.mount_path, "root_path", must_exist=True)

    with folder_check_job_lock:
        running = folder_check_job_state.get("status") == "running"
        existing_job_id = folder_check_job_state.get("job_id")
        if running and isinstance(existing_job_id, str):
            return FolderCheckScanStartResponse(job_id=existing_job_id, status="running", message="scan already running")

        job_id = str(uuid.uuid4())
        folder_check_job_state.update(
            {
                "job_id": job_id,
                "status": "running",
                "root_path": root_path,
                "started_at": datetime.now(UTC).replace(tzinfo=None),
                "finished_at": None,
                "scanned_directories": 0,
                "scanned_files": 0,
                "max_files": MAX_FOLDER_CHECK_FILES,
                "progress_percent": 0,
                "current_item": None,
                "error_message": None,
                "result": None,
            }
        )

    threading.Thread(target=_run_folder_check_scan_job, args=(job_id, root_path), daemon=True, name="folder-check-scan").start()
    return FolderCheckScanStartResponse(job_id=job_id, status="running", message="scan started")


@router.get("/folder-check/scan/status", response_model=FolderCheckScanStatusResponse)
def folder_check_scan_status() -> FolderCheckScanStatusResponse:
    return _folder_check_status_response()


@router.get("/folder-check/latest", response_model=FolderCheckScanResponse)
def folder_check_latest() -> FolderCheckScanResponse:
    payload = _load_json_file(FOLDER_CHECK_RESULT_PATH)
    if not payload:
        raise HTTPException(status_code=404, detail="No Folder Check result available yet")
    return FolderCheckScanResponse.model_validate(payload)


@router.get("/folder-check/preview")
def folder_check_preview(relative_path: str = Query(min_length=1), db: Session = Depends(get_db)) -> FileResponse:
    drive = _get_folder_check_drive(db)
    if drive is None or not drive.mount_path:
        raise HTTPException(status_code=400, detail="No Folder Check drive selected")

    root = Path(validate_workflow_directory_path(drive.mount_path, "root_path", must_exist=True))
    candidate = _resolve_under_root(root, relative_path)
    if not candidate.exists() or not candidate.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    if candidate.suffix.lower() not in FOLDER_CHECK_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported preview file type")

    return FileResponse(candidate)


@router.post("/folder-check/duplicates/resolve", response_model=FolderCheckResolveDuplicateResponse)
def folder_check_resolve_duplicates(
    payload: FolderCheckResolveDuplicateRequest,
    db: Session = Depends(get_db),
) -> FolderCheckResolveDuplicateResponse:
    drive = _get_folder_check_drive(db)
    if drive is None or not drive.mount_path:
        raise HTTPException(status_code=400, detail="No Folder Check drive selected")

    root = Path(validate_workflow_directory_path(drive.mount_path, "root_path", must_exist=True))
    latest_payload = _load_json_file(FOLDER_CHECK_RESULT_PATH)
    if not latest_payload:
        raise HTTPException(status_code=404, detail="No Folder Check result available yet")

    latest = FolderCheckScanResponse.model_validate(latest_payload)
    duplicate_group = [
        item
        for item in latest.files
        if item.sha256 == payload.sha256 and item.duplicate
    ]
    if len(duplicate_group) < 2:
        raise HTTPException(status_code=400, detail="Duplicate group not found or too small")

    keep_item = next((item for item in duplicate_group if item.relative_path == payload.keep_relative_path), None)
    if keep_item is None:
        raise HTTPException(status_code=400, detail="keep_relative_path does not belong to duplicate group")

    deleted_count = 0
    skipped_missing_count = 0
    errors: list[str] = []
    removed_paths: set[str] = set()

    for item in duplicate_group:
        if item.relative_path == payload.keep_relative_path:
            continue

        candidate = _resolve_under_root(root, item.relative_path)
        if not candidate.exists():
            skipped_missing_count += 1
            removed_paths.add(item.relative_path)
            continue

        try:
            candidate.unlink()
            deleted_count += 1
            removed_paths.add(item.relative_path)
        except OSError as exc:
            errors.append(f"{item.relative_path}: {exc}")

    refreshed_files = [item for item in latest.files if item.relative_path not in removed_paths]
    refreshed_files = _normalize_folder_check_files(refreshed_files)
    refreshed = FolderCheckScanResponse(
        root_path=latest.root_path,
        scanned_at=datetime.now(UTC).replace(tzinfo=None),
        duration_ms=0,
        summary=_build_folder_check_summary(refreshed_files, latest.summary.directories_total),
        files=refreshed_files,
        scan_errors=latest.scan_errors,
    )

    state_payload = _load_json_file(FOLDER_CHECK_STATE_PATH)
    state_files = state_payload.get("files") if isinstance(state_payload.get("files"), dict) else {}
    if isinstance(state_files, dict):
        for relative_path in removed_paths:
            state_files.pop(relative_path, None)
        state_payload["files"] = state_files
        state_payload["updated_at"] = datetime.now(UTC).replace(tzinfo=None).isoformat()
        try:
            _write_json_file(FOLDER_CHECK_STATE_PATH, state_payload)
        except OSError as exc:
            errors.append(f"state_update_failed: {exc}")

    try:
        _write_json_file(FOLDER_CHECK_RESULT_PATH, refreshed.model_dump(mode="json"))
    except OSError as exc:
        errors.append(f"result_update_failed: {exc}")

    return FolderCheckResolveDuplicateResponse(
        kept_relative_path=payload.keep_relative_path,
        deleted_count=deleted_count,
        skipped_missing_count=skipped_missing_count,
        errors=errors,
        result=refreshed,
    )


@router.post("/scan", response_model=ScanResponse)
def scan() -> ScanResponse:
    from app.main import app_state

    discovered, queued = app_state.scheduler.enqueue_full_scan(trigger="manual")
    return ScanResponse(discovered=discovered, queued=queued)


@router.get("/scan-schedule", response_model=ScanScheduleResponse)
def get_scan_schedule() -> ScanScheduleResponse:
    return get_scan_schedule_response()


@router.put("/scan-schedule/interval", response_model=ScanScheduleResponse)
def update_scan_interval(payload: ScanScheduleUpdate) -> ScanScheduleResponse:
    from app.main import app_state

    app_state.scheduler.set_interval_seconds(payload.interval_seconds)
    return get_scan_schedule_response()


@router.post("/scan-schedule/start", response_model=ScanScheduleResponse)
def start_scan_schedule() -> ScanScheduleResponse:
    from app.main import app_state

    app_state.scheduler.resume()
    return get_scan_schedule_response()


@router.post("/scan-schedule/stop", response_model=ScanScheduleResponse)
def stop_scan_schedule() -> ScanScheduleResponse:
    from app.main import app_state

    app_state.scheduler.pause()
    return get_scan_schedule_response()


@router.post("/stats/reset", response_model=StatsResetResponse)
def reset_stats(db: Session = Depends(get_db)) -> StatsResetResponse:
    result = db.execute(delete(ProcessedMedia))
    db.commit()
    return StatsResetResponse(status="reset", deleted_rows=int(result.rowcount or 0))


@router.get("/workflows", response_model=list[WorkflowItem])
def list_workflows(db: Session = Depends(get_db)) -> list[WorkflowItem]:
    rows = db.scalars(select(Workflow).order_by(Workflow.created_at.desc())).all()
    return [
        WorkflowItem(
            id=row.id,
            name=row.name,
            source_path=row.source_path,
            destination_path=row.destination_path,
            failed_path=row.failed_path,
            allowed_extensions=row.allowed_extensions,
            enabled=row.enabled,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )
        for row in rows
    ]


@router.post("/workflows", response_model=WorkflowItem)
def create_workflow(payload: WorkflowCreate, db: Session = Depends(get_db)) -> WorkflowItem:
    if db.scalar(select(Workflow).where(Workflow.name == payload.name)):
        raise HTTPException(status_code=409, detail="Workflow name already exists")
    source_value = validate_workflow_directory_path(payload.source_path, "source_path", must_exist=True)
    destination_value = validate_workflow_directory_path(payload.destination_path, "destination_path", must_exist=False)
    failed_value = validate_workflow_directory_path(payload.failed_path, "failed_path", must_exist=False)

    if db.scalar(select(Workflow).where(Workflow.source_path == source_value)):
        raise HTTPException(status_code=409, detail="Workflow source_path already exists")

    workflow = Workflow(
        name=payload.name.strip(),
        source_path=source_value,
        destination_path=destination_value,
        failed_path=failed_value,
        allowed_extensions=normalize_extensions(payload.allowed_extensions),
        naming_pattern=FIXED_NAMING_PATTERN,
        timestamp_format=FIXED_TIMESTAMP_FORMAT,
        enabled=payload.enabled,
    )
    db.add(workflow)
    db.commit()
    db.refresh(workflow)
    return WorkflowItem(
        id=workflow.id,
        name=workflow.name,
        source_path=workflow.source_path,
        destination_path=workflow.destination_path,
        failed_path=workflow.failed_path,
        allowed_extensions=workflow.allowed_extensions,
        enabled=workflow.enabled,
        created_at=workflow.created_at,
        updated_at=workflow.updated_at,
    )


@router.put("/workflows/{workflow_id}", response_model=WorkflowItem)
def update_workflow(workflow_id: int, payload: WorkflowUpdate, db: Session = Depends(get_db)) -> WorkflowItem:
    workflow = db.scalar(select(Workflow).where(Workflow.id == workflow_id))
    if workflow is None:
        raise HTTPException(status_code=404, detail="Workflow not found")

    conflicting_name = db.scalar(select(Workflow).where(Workflow.name == payload.name, Workflow.id != workflow_id))
    if conflicting_name:
        raise HTTPException(status_code=409, detail="Workflow name already exists")

    source_value = validate_workflow_directory_path(payload.source_path, "source_path", must_exist=True)
    destination_value = validate_workflow_directory_path(payload.destination_path, "destination_path", must_exist=False)
    failed_value = validate_workflow_directory_path(payload.failed_path, "failed_path", must_exist=False)

    conflicting_source = db.scalar(select(Workflow).where(Workflow.source_path == source_value, Workflow.id != workflow_id))
    if conflicting_source:
        raise HTTPException(status_code=409, detail="Workflow source_path already exists")

    workflow.name = payload.name.strip()
    workflow.source_path = source_value
    workflow.destination_path = destination_value
    workflow.failed_path = failed_value
    workflow.allowed_extensions = normalize_extensions(payload.allowed_extensions)
    workflow.naming_pattern = FIXED_NAMING_PATTERN
    workflow.timestamp_format = FIXED_TIMESTAMP_FORMAT
    workflow.enabled = payload.enabled
    db.commit()
    db.refresh(workflow)

    return WorkflowItem(
        id=workflow.id,
        name=workflow.name,
        source_path=workflow.source_path,
        destination_path=workflow.destination_path,
        failed_path=workflow.failed_path,
        allowed_extensions=workflow.allowed_extensions,
        enabled=workflow.enabled,
        created_at=workflow.created_at,
        updated_at=workflow.updated_at,
    )


@router.delete("/workflows/{workflow_id}")
def delete_workflow(workflow_id: int, db: Session = Depends(get_db)) -> dict[str, str]:
    workflow = db.scalar(select(Workflow).where(Workflow.id == workflow_id))
    if workflow is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    db.delete(workflow)
    db.commit()
    return {"status": "deleted"}


def to_network_drive_item(row: NetworkDrive) -> NetworkDriveItem:
    return NetworkDriveItem(
        id=row.id,
        name=row.name,
        smb_path=row.smb_path,
        mount_path=row.mount_path,
        username=row.username,
        has_password=bool(row.password),
        enabled=row.enabled,
        folder_check_enabled=row.folder_check_enabled,
        connection_status=row.connection_status,
        last_checked_at=row.last_checked_at,
        last_error=row.last_error,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get("/network-drives", response_model=list[NetworkDriveItem])
def list_network_drives(db: Session = Depends(get_db)) -> list[NetworkDriveItem]:
    rows = db.scalars(select(NetworkDrive).order_by(NetworkDrive.name.asc())).all()
    return [to_network_drive_item(row) for row in rows]


@router.post("/network-drives/discover-shares", response_model=list[str])
def discover_network_drive_shares(payload: NetworkShareDiscoveryRequest) -> list[str]:
    ok, result = list_smb_available_shares(payload.server, payload.username, payload.password)
    if not ok:
        raise HTTPException(status_code=400, detail=str(result))
    return list(result)


@router.get("/network-drives/{drive_id}/folders", response_model=list[str])
def list_network_drive_folders(drive_id: int, db: Session = Depends(get_db)) -> list[str]:
    drive = db.scalar(select(NetworkDrive).where(NetworkDrive.id == drive_id))
    if drive is None:
        raise HTTPException(status_code=404, detail="Network drive not found")

    if not drive.mount_path:
        return []

    mount_root = Path(drive.mount_path)
    if not mount_root.exists() or not mount_root.is_dir():
        logger.warning(
            "Mount path not available for folder listing",
            extra={"drive_id": drive.id, "mount_path": drive.mount_path},
        )
        return list_smb_top_level_folders(drive.smb_path, drive.username, drive.password or "")

    folders: set[str] = set()
    try:
        for candidate in mount_root.rglob("*"):
            if candidate.is_dir():
                relative = candidate.relative_to(mount_root).as_posix().strip("/")
                if relative and not relative.startswith("."):
                    folders.add(relative)
    except OSError as exc:
        logger.warning(
            "Cannot list folders under mount path",
            extra={"drive_id": drive.id, "mount_path": drive.mount_path, "error": str(exc)},
        )
        return list_smb_top_level_folders(drive.smb_path, drive.username, drive.password or "")

    return sorted(folders)


@router.post("/network-drives", response_model=NetworkDriveItem)
def create_network_drive(payload: NetworkDriveCreate, db: Session = Depends(get_db)) -> NetworkDriveItem:
    if db.scalar(select(NetworkDrive).where(NetworkDrive.name == payload.name.strip())):
        raise HTTPException(status_code=409, detail="Network drive name already exists")
    ok, message = validate_smb_path(payload.smb_path)
    if not ok:
        raise HTTPException(status_code=400, detail=message)
    try:
        mount_path = ensure_mount_path_exists(payload.mount_path)
    except OSError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot create mount_path '{payload.mount_path}': {exc}",
        ) from exc

    drive = NetworkDrive(
        name=payload.name.strip(),
        smb_path=message,
        mount_path=mount_path,
        username=payload.username.strip(),
        password=payload.password,
        enabled=payload.enabled,
        connection_status="unknown",
        last_error=None,
    )

    check_result = check_network_drive(drive.smb_path, drive.username, drive.password, drive.mount_path)
    drive.connection_status = check_result.status
    drive.last_checked_at = check_result.checked_at
    drive.last_error = None if check_result.connected else check_result.message

    db.add(drive)
    db.commit()
    db.refresh(drive)
    return to_network_drive_item(drive)


@router.post("/network-drives/{drive_id}/clone", response_model=NetworkDriveItem)
def clone_network_drive(drive_id: int, payload: NetworkDriveClone, db: Session = Depends(get_db)) -> NetworkDriveItem:
    source_drive = db.scalar(select(NetworkDrive).where(NetworkDrive.id == drive_id))
    if source_drive is None:
        raise HTTPException(status_code=404, detail="Network drive not found")

    if db.scalar(select(NetworkDrive).where(NetworkDrive.name == payload.name.strip())):
        raise HTTPException(status_code=409, detail="Network drive name already exists")

    ok, message = validate_smb_path(payload.smb_path)
    if not ok:
        raise HTTPException(status_code=400, detail=message)

    try:
        mount_path = ensure_mount_path_exists(payload.mount_path)
    except OSError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot create mount_path '{payload.mount_path}': {exc}",
        ) from exc

    password = payload.password if payload.password else source_drive.password

    drive = NetworkDrive(
        name=payload.name.strip(),
        smb_path=message,
        mount_path=mount_path,
        username=payload.username.strip(),
        password=password,
        enabled=payload.enabled,
        connection_status="unknown",
        last_error=None,
    )

    check_result = check_network_drive(drive.smb_path, drive.username, drive.password, drive.mount_path)
    drive.connection_status = check_result.status
    drive.last_checked_at = check_result.checked_at
    drive.last_error = None if check_result.connected else check_result.message

    db.add(drive)
    db.commit()
    db.refresh(drive)
    return to_network_drive_item(drive)


@router.put("/network-drives/{drive_id}", response_model=NetworkDriveItem)
def update_network_drive(drive_id: int, payload: NetworkDriveUpdate, db: Session = Depends(get_db)) -> NetworkDriveItem:
    drive = db.scalar(select(NetworkDrive).where(NetworkDrive.id == drive_id))
    if drive is None:
        raise HTTPException(status_code=404, detail="Network drive not found")

    conflicting_name = db.scalar(select(NetworkDrive).where(NetworkDrive.name == payload.name.strip(), NetworkDrive.id != drive_id))
    if conflicting_name:
        raise HTTPException(status_code=409, detail="Network drive name already exists")

    ok, message = validate_smb_path(payload.smb_path)
    if not ok:
        raise HTTPException(status_code=400, detail=message)
    try:
        mount_path = ensure_mount_path_exists(payload.mount_path)
    except OSError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot create mount_path '{payload.mount_path}': {exc}",
        ) from exc

    drive.name = payload.name.strip()
    drive.smb_path = message
    drive.mount_path = mount_path
    drive.username = payload.username.strip()
    if payload.password:
        drive.password = payload.password
    drive.enabled = payload.enabled

    check_result = check_network_drive(drive.smb_path, drive.username, drive.password, drive.mount_path)
    drive.connection_status = check_result.status
    drive.last_checked_at = check_result.checked_at
    drive.last_error = None if check_result.connected else check_result.message

    db.commit()
    db.refresh(drive)
    return to_network_drive_item(drive)


@router.post("/network-drives/{drive_id}/check", response_model=NetworkDriveItem)
def check_network_drive_connection(drive_id: int, db: Session = Depends(get_db)) -> NetworkDriveItem:
    drive = db.scalar(select(NetworkDrive).where(NetworkDrive.id == drive_id))
    if drive is None:
        raise HTTPException(status_code=404, detail="Network drive not found")

    result = check_network_drive(drive.smb_path, drive.username, drive.password, drive.mount_path)
    drive.connection_status = result.status
    drive.last_checked_at = result.checked_at
    drive.last_error = None if result.connected else result.message
    db.commit()
    db.refresh(drive)
    return to_network_drive_item(drive)


@router.post("/network-drives/{drive_id}/mount", response_model=NetworkDriveItem)
def mount_network_drive_endpoint(drive_id: int, db: Session = Depends(get_db)) -> NetworkDriveItem:
    drive = db.scalar(select(NetworkDrive).where(NetworkDrive.id == drive_id))
    if drive is None:
        raise HTTPException(status_code=404, detail="Network drive not found")
    if not drive.mount_path:
        raise HTTPException(status_code=400, detail="mount_path is required")

    ok, message = mount_network_drive_via_helper(drive.smb_path, drive.mount_path, drive.username, drive.password)
    if not ok:
        drive.connection_status = "mount_error"
        drive.last_checked_at = None
        drive.last_error = message
        db.commit()
        db.refresh(drive)
        raise HTTPException(status_code=400, detail=message)

    result = check_network_drive(drive.smb_path, drive.username, drive.password, drive.mount_path)
    drive.connection_status = result.status
    drive.last_checked_at = result.checked_at
    drive.last_error = None if result.connected else result.message
    db.commit()
    db.refresh(drive)
    return to_network_drive_item(drive)


@router.put("/network-drives/{drive_id}/folder-check", response_model=NetworkDriveItem)
def set_network_drive_folder_check(drive_id: int, payload: NetworkDriveFolderCheckUpdate, db: Session = Depends(get_db)) -> NetworkDriveItem:
    drive = db.scalar(select(NetworkDrive).where(NetworkDrive.id == drive_id))
    if drive is None:
        raise HTTPException(status_code=404, detail="Network drive not found")

    if payload.selected and not drive.mount_path:
        raise HTTPException(status_code=400, detail="Selected drive requires mount_path")

    if payload.selected:
        all_drives = db.scalars(select(NetworkDrive)).all()
        for item in all_drives:
            item.folder_check_enabled = item.id == drive_id
    else:
        drive.folder_check_enabled = False

    db.commit()
    db.refresh(drive)
    return to_network_drive_item(drive)


@router.delete("/network-drives/{drive_id}")
def delete_network_drive(drive_id: int, db: Session = Depends(get_db)) -> dict[str, str]:
    drive = db.scalar(select(NetworkDrive).where(NetworkDrive.id == drive_id))
    if drive is None:
        raise HTTPException(status_code=404, detail="Network drive not found")
    db.delete(drive)
    db.commit()
    return {"status": "deleted"}
