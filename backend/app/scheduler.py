from __future__ import annotations

from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler

from app.config import Settings
from app.media import MediaProcessor


class ScanScheduler:
    def __init__(self, settings: Settings, processor: MediaProcessor):
        self.settings = settings
        self.processor = processor
        self.scheduler = BackgroundScheduler(timezone=settings.timezone)

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

    def enqueue_full_scan(self) -> tuple[int, int]:
        discovered = 0
        queued = 0
        for source_share in self.settings.source_shares:
            for file_path in source_share.rglob("*"):
                if not file_path.is_file():
                    continue
                discovered += 1
                if self.processor.enqueue_file(Path(file_path)):
                    queued += 1
        return discovered, queued
