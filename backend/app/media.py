from __future__ import annotations

import hashlib
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from queue import Empty, Queue

from sqlalchemy import func, or_, select

from app.config import Settings
from app.db import SessionLocal
from app.exif import extract_capture_time, read_metadata
from app.models import NetworkDrive, ProcessedMedia, Workflow
from app.network_drives import count_smb_files_recursive

logger = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {
    ".heic",
    ".heif",
    ".jpg",
    ".jpeg",
    ".png",
    ".tiff",
    ".dng",
    ".mov",
    ".mp4",
    ".avi",
    ".m4v",
}

HEIC_EXTENSIONS = {".heic", ".heif"}
FIXED_TIMESTAMP_FORMAT = "%Y%m%d_%H%M%S"


@dataclass
class QueueStats:
    queued_files: int
    workers_alive: int


@dataclass
class WorkflowTarget:
    destination_path: Path
    failed_path: Path
    allowed_extensions: set[str] | None


@dataclass
class WorkflowSourceStats:
    workflow_id: int
    workflow_name: str
    source_path: str
    enabled: bool
    files_total: int
    queued_files: int
    processed_files: int
    failed_files: int
    duplicate_files: int


class MediaProcessor:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.queue: Queue[Path] = Queue()
        self._workers: list[threading.Thread] = []
        self._stop_event = threading.Event()
        self._queued_or_running_paths: set[str] = set()
        self._queue_lock = threading.Lock()

    def start(self) -> None:
        self.settings.destination_share.mkdir(parents=True, exist_ok=True)
        self.settings.failed_share.mkdir(parents=True, exist_ok=True)

        for _ in range(self.settings.worker_count):
            worker = threading.Thread(target=self._worker_loop, daemon=True)
            worker.start()
            self._workers.append(worker)

    def stop(self) -> None:
        self._stop_event.set()
        for _ in self._workers:
            self.queue.put(Path("__STOP__"))
        for worker in self._workers:
            worker.join(timeout=3)

    def enqueue_file(self, path: Path) -> bool:
        ext = path.suffix.lower()
        if ext not in SUPPORTED_EXTENSIONS:
            return False
        if not path.exists() or not path.is_file():
            return False
        path_key = str(path)
        with self._queue_lock:
            if path_key in self._queued_or_running_paths:
                return False
            self._queued_or_running_paths.add(path_key)
        self.queue.put(path)
        return True

    def get_queue_stats(self) -> QueueStats:
        return QueueStats(
            queued_files=self.queue.qsize(),
            workers_alive=sum(1 for worker in self._workers if worker.is_alive()),
        )

    def get_db_stats(self) -> dict[str, int]:
        with SessionLocal() as session:
            total_processed = session.scalar(select(func.count()).where(ProcessedMedia.status == "processed")) or 0
            total_failed = session.scalar(select(func.count()).where(ProcessedMedia.status == "failed")) or 0
            total_duplicates = session.scalar(select(func.count()).where(ProcessedMedia.status == "duplicate")) or 0
        return {
            "total_processed": int(total_processed),
            "total_failed": int(total_failed),
            "total_duplicates": int(total_duplicates),
        }

    def get_workflow_source_stats(self) -> list[WorkflowSourceStats]:
        with SessionLocal() as session:
            workflows = session.scalars(select(Workflow).order_by(Workflow.name.asc())).all()

            queued_by_workflow: dict[int, int] = {workflow.id: 0 for workflow in workflows}
            enabled_workflows = [workflow for workflow in workflows if workflow.enabled]
            enabled_workflows.sort(key=lambda workflow: len(workflow.source_path), reverse=True)

            queued_paths: list[str] = []
            with self.queue.mutex:
                queued_paths = [str(item) for item in self.queue.queue if str(item) != "__STOP__"]

            for queued_path in queued_paths:
                for workflow in enabled_workflows:
                    root = workflow.source_path.rstrip("/") or workflow.source_path
                    if queued_path == root or queued_path.startswith(f"{root}/"):
                        queued_by_workflow[workflow.id] = queued_by_workflow.get(workflow.id, 0) + 1
                        break

            stats: list[WorkflowSourceStats] = []
            for workflow in workflows:
                source_root = workflow.source_path.rstrip("/") or workflow.source_path
                source_filter = or_(
                    ProcessedMedia.source_path == source_root,
                    ProcessedMedia.source_path.like(f"{source_root}/%"),
                )

                processed_files = session.scalar(
                    select(func.count()).where(source_filter, ProcessedMedia.status == "processed")
                ) or 0
                failed_files = session.scalar(
                    select(func.count()).where(source_filter, ProcessedMedia.status == "failed")
                ) or 0
                duplicate_files = session.scalar(
                    select(func.count()).where(source_filter, ProcessedMedia.status == "duplicate")
                ) or 0

                stats.append(
                    WorkflowSourceStats(
                        workflow_id=workflow.id,
                        workflow_name=workflow.name,
                        source_path=workflow.source_path,
                        enabled=workflow.enabled,
                        files_total=self._count_source_files(workflow.source_path),
                        queued_files=queued_by_workflow.get(workflow.id, 0),
                        processed_files=int(processed_files),
                        failed_files=int(failed_files),
                        duplicate_files=int(duplicate_files),
                    )
                )

        return stats

    def _count_source_files(self, source_path: str) -> int:
        source_root = Path(source_path)
        if not source_root.exists() or not source_root.is_dir():
            return self._count_source_files_from_smb(source_path)

        total = 0
        try:
            for entry in os.scandir(source_root):
                if not entry.is_file():
                    continue
                extension = Path(entry.name).suffix.lower()
                if extension in SUPPORTED_EXTENSIONS:
                    total += 1
        except OSError:
            return 0

        return total

    def _count_source_files_from_smb(self, source_path: str) -> int:
        source = source_path.rstrip("/") or source_path
        if not source:
            return 0

        with SessionLocal() as session:
            drives = session.scalars(select(NetworkDrive).where(NetworkDrive.enabled.is_(True))).all()

        matching = [
            drive
            for drive in drives
            if drive.mount_path and (source == drive.mount_path or source.startswith(f"{drive.mount_path.rstrip('/')}/"))
        ]
        if not matching:
            return 0

        drive = sorted(matching, key=lambda item: len(item.mount_path or ""), reverse=True)[0]
        mount_root = (drive.mount_path or "").rstrip("/")
        subpath = source[len(mount_root):].lstrip("/") if mount_root and source != mount_root else ""

        return count_smb_files_recursive(
            smb_path=drive.smb_path,
            username=drive.username,
            password=drive.password,
            subpath=subpath,
            allowed_extensions=SUPPORTED_EXTENSIONS,
            recursive=False,
        )

    def _worker_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                path = self.queue.get(timeout=1)
            except Empty:
                continue

            if str(path) == "__STOP__":
                self.queue.task_done()
                break

            try:
                self._process_file(path)
            except Exception:
                logger.exception("Unhandled processing error", extra={"source_path": str(path), "status": "failed"})
            finally:
                with self._queue_lock:
                    self._queued_or_running_paths.discard(str(path))
                self.queue.task_done()

    def _process_file(self, source_path: Path) -> None:
        if not self._wait_for_file_ready(
            source_path,
            min_age_seconds=self.settings.file_ready_min_age_seconds,
            stable_checks=self.settings.file_ready_checks,
            check_interval_seconds=self.settings.file_ready_check_interval_seconds,
        ):
            logger.warning("File not stable yet; deferred", extra={"source_path": str(source_path), "status": "deferred"})
            return

        source_hash = self._sha256(source_path)
        extension = source_path.suffix.lower()
        target = self._resolve_target_for_source(source_path)

        if target.allowed_extensions is not None and extension not in target.allowed_extensions:
            logger.info(
                "File skipped by workflow extension rules",
                extra={"source_path": str(source_path), "status": "skipped"},
            )
            return

        work_path = source_path
        converted_path: Path | None = None
        try:
            target.destination_path.mkdir(parents=True, exist_ok=True)
            target.failed_path.mkdir(parents=True, exist_ok=True)

            with SessionLocal() as session:
                existing = session.scalar(select(ProcessedMedia).where(ProcessedMedia.source_hash == source_hash))
                if existing:
                    duplicate_path = self._build_failed_destination(source_path, target.failed_path, "duplicates")
                    duplicate_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(source_path), str(duplicate_path))
                    logger.info("Duplicate file skipped", extra={"source_path": str(source_path), "status": "duplicate"})
                    duplicate = ProcessedMedia(
                        source_path=str(source_path),
                        source_hash=hashlib.sha256(f"{source_hash}:{source_path}:{time.time_ns()}".encode("utf-8")).hexdigest(),
                        destination_path=str(duplicate_path),
                        extension=extension,
                        captured_at=existing.captured_at,
                        status="duplicate",
                        error_message="Duplicate hash",
                    )
                    session.add(duplicate)
                    session.commit()
                    return

            metadata = read_metadata(source_path, self.settings.exiftool_path)
            captured_at = extract_capture_time(metadata) or datetime.now()

            if extension in HEIC_EXTENSIONS:
                converted_path = self._convert_heic(source_path)
                work_path = converted_path
                extension = ".jpg"

            destination_path = self._build_unique_destination(captured_at, extension, target)
            destination_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(work_path), str(destination_path))
            if converted_path is not None and source_path.exists():
                source_path.unlink(missing_ok=True)

            with SessionLocal() as session:
                session.add(
                    ProcessedMedia(
                        source_path=str(source_path),
                        source_hash=source_hash,
                        destination_path=str(destination_path),
                        extension=extension,
                        captured_at=captured_at,
                        status="processed",
                    )
                )
                session.commit()

            logger.info(
                "File processed",
                extra={
                    "source_path": str(source_path),
                    "destination_path": str(destination_path),
                    "status": "processed",
                },
            )
        except Exception as exc:
            try:
                fail_path = self._build_failed_destination(source_path, target.failed_path)
                fail_path.parent.mkdir(parents=True, exist_ok=True)
                if source_path.exists():
                    shutil.move(str(source_path), str(fail_path))
            except Exception:
                logger.exception(
                    "Failed to move source into failed folder",
                    extra={"source_path": str(source_path), "status": "failed"},
                )

            try:
                with SessionLocal() as session:
                    session.add(
                        ProcessedMedia(
                            source_path=str(source_path),
                            source_hash=hashlib.sha256(f"{source_hash}:failed:{source_path}:{time.time_ns()}".encode("utf-8")).hexdigest(),
                            destination_path=None,
                            extension=extension,
                            captured_at=None,
                            status="failed",
                            error_message=str(exc),
                        )
                    )
                    session.commit()
            except Exception:
                logger.exception(
                    "Failed to record failed processing event",
                    extra={"source_path": str(source_path), "status": "failed"},
                )

            logger.exception("File processing failed", extra={"source_path": str(source_path), "status": "failed"})

    def _resolve_target_for_source(self, source_path: Path) -> WorkflowTarget:
        selected: Workflow | None = None
        source_text = str(source_path)
        with SessionLocal() as session:
            workflows = session.scalars(select(Workflow).where(Workflow.enabled.is_(True))).all()

        for workflow in workflows:
            root = workflow.source_path.rstrip("/")
            if not root:
                continue
            if source_text == root or source_text.startswith(f"{root}/"):
                if selected is None or len(workflow.source_path) > len(selected.source_path):
                    selected = workflow

        if selected is not None:
            allowed_extensions = self._parse_allowed_extensions(selected.allowed_extensions)
            return WorkflowTarget(
                destination_path=Path(selected.destination_path),
                failed_path=Path(selected.failed_path),
                allowed_extensions=allowed_extensions,
            )

        return WorkflowTarget(
            destination_path=self.settings.destination_share,
            failed_path=self.settings.failed_share,
            allowed_extensions=None,
        )

    def _build_failed_destination(self, source_path: Path, failed_root: Path, subfolder: str = "") -> Path:
        root = failed_root
        if subfolder:
            root = root / subfolder
        candidate = root / source_path.name
        if not candidate.exists():
            return candidate

        stem = source_path.stem
        extension = source_path.suffix
        counter = 1
        while True:
            candidate = root / f"{stem}_{counter:02d}{extension}"
            if not candidate.exists():
                return candidate
            counter += 1

    def _wait_for_file_ready(
        self,
        path: Path,
        min_age_seconds: float = 2.0,
        stable_checks: int = 2,
        check_interval_seconds: float = 1.0,
    ) -> bool:
        previous_signature: tuple[int, int] | None = None
        stable_count = 0
        max_attempts = max(stable_checks + 2, stable_checks * 6)

        for _ in range(max_attempts):
            if not path.exists():
                return False
            try:
                stat = path.stat()
            except OSError:
                time.sleep(check_interval_seconds)
                continue

            signature = (stat.st_size, stat.st_mtime_ns)
            age_seconds = max(0.0, time.time() - stat.st_mtime)
            is_stable_now = (
                stat.st_size > 0
                and previous_signature == signature
                and age_seconds >= min_age_seconds
            )

            if is_stable_now:
                stable_count += 1
                if stable_count >= stable_checks:
                    return True
            else:
                stable_count = 0

            previous_signature = signature
            time.sleep(check_interval_seconds)
        return False

    def _convert_heic(self, source_path: Path) -> Path:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as temp_file:
            temp_path = Path(temp_file.name)

        magick_cmd = [self.settings.magick_path, str(source_path), str(temp_path)]
        result = subprocess.run(magick_cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            fallback_cmd = ["convert", str(source_path), str(temp_path)]
            fallback = subprocess.run(fallback_cmd, capture_output=True, text=True, check=False)
            if fallback.returncode != 0:
                raise RuntimeError(f"HEIC conversion failed: {result.stderr.strip()} | {fallback.stderr.strip()}")

        return temp_path

    def _build_unique_destination(self, captured_at: datetime, extension: str, target: WorkflowTarget) -> Path:
        timestamp = captured_at.strftime(FIXED_TIMESTAMP_FORMAT)
        safe_base = f"IMG_{timestamp}"
        year_dir = captured_at.strftime("%Y")
        month_dir = captured_at.strftime("%Y-%m")
        destination_dir = target.destination_path / year_dir / month_dir
        candidate = destination_dir / f"{safe_base}{extension}"
        if not candidate.exists():
            return candidate

        counter = 1
        while True:
            suffix = f"_{counter:02d}"
            candidate = destination_dir / f"{safe_base}{suffix}{extension}"
            if not candidate.exists():
                return candidate
            counter += 1

    @staticmethod
    def _parse_allowed_extensions(raw: str | None) -> set[str] | None:
        if not raw:
            return None
        parts = [item.strip().lower() for item in raw.split(",") if item.strip()]
        if not parts:
            return None
        return {part if part.startswith(".") else f".{part}" for part in parts}

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as file_obj:
            for block in iter(lambda: file_obj.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()
