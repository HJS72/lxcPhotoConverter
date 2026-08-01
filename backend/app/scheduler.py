from __future__ import annotations

from datetime import datetime
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy import select

from app.config import Settings
from app.db import SessionLocal
from app.media import MediaProcessor
from app.models import Workflow


class ScanScheduler:
    def __init__(self, settings: Settings, processor: MediaProcessor):
        self.settings = settings
        self.processor = processor
        self.scheduler = BackgroundScheduler(timezone=settings.timezone)
        self.last_scan_at: datetime | None = None
        self.last_scan_discovered: int = 0
        self.last_scan_queued: int = 0
        self.last_scan_trigger: str | None = None

    def start(self) -> None:
        self.scheduler.add_job(
            self.enqueue_full_scan,
            trigger="interval",
            seconds=self.settings.scan_interval_seconds,
            id="full-scan",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        self.scheduler.start()

    def stop(self) -> None:
        self.scheduler.shutdown(wait=False)

    def enqueue_full_scan(self, trigger: str = "scheduled") -> tuple[int, int]:
        discovered = 0
        queued = 0

        source_roots = {Path(path) for path in self.settings.source_shares}
        with SessionLocal() as session:
            workflows = session.scalars(select(Workflow).where(Workflow.enabled.is_(True))).all()
        for workflow in workflows:
            source_roots.add(Path(workflow.source_path))

        for source_share in source_roots:
            if not source_share.exists():
                continue
            for file_path in source_share.rglob("*"):
                if not file_path.is_file():
                    continue
                discovered += 1
                if self.processor.enqueue_file(Path(file_path)):
                    queued += 1

        self.last_scan_at = datetime.now(self.scheduler.timezone)
        self.last_scan_discovered = discovered
        self.last_scan_queued = queued
        self.last_scan_trigger = trigger
        return discovered, queued

    def get_next_scan_time(self) -> datetime | None:
        job = self.scheduler.get_job("full-scan")
        if job is None:
            return None
        return job.next_run_time

    def get_last_scan_info(self) -> tuple[datetime | None, int, int, str | None]:
        return self.last_scan_at, self.last_scan_discovered, self.last_scan_queued, self.last_scan_trigger

    def get_interval_seconds(self) -> int:
        job = self.scheduler.get_job("full-scan")
        if job is None:
            return int(self.settings.scan_interval_seconds)
        trigger = getattr(job, "trigger", None)
        interval = getattr(trigger, "interval", None)
        if interval is None:
            return int(self.settings.scan_interval_seconds)
        return int(interval.total_seconds())

    def is_enabled(self) -> bool:
        job = self.scheduler.get_job("full-scan")
        if job is None:
            return False
        return job.next_run_time is not None

    def set_interval_seconds(self, seconds: int) -> None:
        if seconds < 1:
            raise ValueError("scan interval must be >= 1 second")
        self.settings.scan_interval_seconds = int(seconds)
        job = self.scheduler.get_job("full-scan")
        if job is None:
            return
        paused = job.next_run_time is None
        self.scheduler.reschedule_job("full-scan", trigger="interval", seconds=int(seconds))
        if paused:
            self.scheduler.pause_job("full-scan")

    def pause(self) -> None:
        if self.scheduler.get_job("full-scan") is not None:
            self.scheduler.pause_job("full-scan")

    def resume(self) -> None:
        if self.scheduler.get_job("full-scan") is not None:
            self.scheduler.resume_job("full-scan")
