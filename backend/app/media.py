from __future__ import annotations

import hashlib
import logging
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from queue import Empty, Queue

from sqlalchemy import func, select

from app.config import Settings
from app.db import SessionLocal
from app.exif import extract_capture_time, read_metadata
from app.models import ProcessedMedia

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


@dataclass
class QueueStats:
    queued_files: int
    workers_alive: int


class MediaProcessor:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.queue: Queue[Path] = Queue()
        self._workers: list[threading.Thread] = []
        self._stop_event = threading.Event()

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
                self.queue.task_done()

    def _process_file(self, source_path: Path) -> None:
        if not self._wait_for_file_ready(source_path):
            logger.warning("File not ready after retries", extra={"source_path": str(source_path), "status": "failed"})
            return

        source_hash = self._sha256(source_path)
        extension = source_path.suffix.lower()

        with SessionLocal() as session:
            existing = session.scalar(select(ProcessedMedia).where(ProcessedMedia.source_hash == source_hash))
            if existing:
                duplicate_path = self._build_failed_destination(source_path, "duplicates")
                duplicate_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(source_path), str(duplicate_path))
                logger.info("Duplicate file skipped", extra={"source_path": str(source_path), "status": "duplicate"})
                duplicate = ProcessedMedia(
                    source_path=str(source_path),
                    source_hash=source_hash,
                    destination_path=str(duplicate_path),
                    extension=extension,
                    captured_at=existing.captured_at,
                    status="duplicate",
                    error_message="Duplicate hash",
                )
                session.add(duplicate)
                session.commit()
                return

        work_path = source_path
        converted_path: Path | None = None
        try:
            metadata = read_metadata(source_path, self.settings.exiftool_path)
            captured_at = extract_capture_time(metadata) or datetime.now()

            if extension in HEIC_EXTENSIONS:
                converted_path = self._convert_heic(source_path)
                work_path = converted_path
                extension = ".jpg"

            destination_path = self._build_unique_destination(captured_at, extension)
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
            fail_path = self._build_failed_destination(source_path)
            fail_path.parent.mkdir(parents=True, exist_ok=True)
            if source_path.exists():
                shutil.move(str(source_path), str(fail_path))

            with SessionLocal() as session:
                session.add(
                    ProcessedMedia(
                        source_path=str(source_path),
                        source_hash=source_hash,
                        destination_path=None,
                        extension=extension,
                        captured_at=None,
                        status="failed",
                        error_message=str(exc),
                    )
                )
                session.commit()

            logger.exception("File processing failed", extra={"source_path": str(source_path), "status": "failed"})

    def _build_failed_destination(self, source_path: Path, subfolder: str = "") -> Path:
        root = self.settings.failed_share
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

    def _wait_for_file_ready(self, path: Path, retries: int = 10, delay: float = 1.0) -> bool:
        previous_size = -1
        for _ in range(retries):
            if not path.exists():
                return False
            current_size = path.stat().st_size
            if current_size > 0 and current_size == previous_size:
                return True
            previous_size = current_size
            time.sleep(delay)
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

    def _build_unique_destination(self, captured_at: datetime, extension: str) -> Path:
        base_name = f"IMG_{captured_at.strftime('%Y%m%d_%H%M%S')}"
        candidate = self.settings.destination_share / f"{base_name}{extension}"
        if not candidate.exists():
            return candidate

        counter = 1
        while True:
            suffix = f"_{counter:02d}"
            candidate = self.settings.destination_share / f"{base_name}{suffix}{extension}"
            if not candidate.exists():
                return candidate
            counter += 1

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as file_obj:
            for block in iter(lambda: file_obj.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()
