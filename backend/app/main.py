from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from app.api.routes import router
from app.config import Settings, get_settings
from app.db import SessionLocal, init_db
from app.logging_config import configure_logging
from app.media import MediaProcessor
from app.models import NetworkDrive
from app.network_drives import check_network_drive, mount_network_drive_via_helper
from app.scheduler import ScanScheduler
from app.watcher import ShareWatcher

logger = logging.getLogger(__name__)


@dataclass
class AppState:
    settings: Settings
    processor: MediaProcessor
    watcher: ShareWatcher
    scheduler: ScanScheduler


settings = get_settings()
configure_logging(settings.log_level)

processor = MediaProcessor(settings)
watcher = ShareWatcher(processor.enqueue_file)
scheduler = ScanScheduler(settings, processor)
app_state = AppState(settings=settings, processor=processor, watcher=watcher, scheduler=scheduler)

app = FastAPI(title=settings.app_name)
app.include_router(router, prefix=settings.api_prefix)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")


def _check_and_mount_network_drives_on_startup() -> None:
    try:
        with SessionLocal() as session:
            drives = session.scalars(select(NetworkDrive).where(NetworkDrive.enabled.is_(True))).all()

            for drive in drives:
                result = check_network_drive(drive.smb_path, drive.username, drive.password, drive.mount_path)

                if not result.connected and drive.mount_path:
                    mounted, mount_message = mount_network_drive_via_helper(
                        drive.smb_path,
                        drive.mount_path,
                        drive.username,
                        drive.password,
                    )
                    if mounted:
                        result = check_network_drive(drive.smb_path, drive.username, drive.password, drive.mount_path)
                    else:
                        logger.warning(
                            "Network drive auto-mount failed on startup",
                            extra={"drive_id": drive.id, "drive_name": drive.name, "error": mount_message},
                        )

                drive.connection_status = result.status
                drive.last_checked_at = result.checked_at
                drive.last_error = None if result.connected else result.message

            session.commit()
    except Exception:
        logger.exception("Startup network drive check failed", extra={"status": "failed"})


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    _check_and_mount_network_drives_on_startup()
    processor.start()
    watcher.start(settings.source_shares, recursive=settings.observer_recursive)
    scheduler.start()

    def run_initial_scan() -> None:
        try:
            scheduler.enqueue_full_scan(trigger="startup")
        except Exception:
            logger.exception("Initial full scan failed", extra={"status": "failed"})

    threading.Thread(target=run_initial_scan, name="initial-full-scan", daemon=True).start()
    logger.info("Service started", extra={"status": "started"})


@app.on_event("shutdown")
def on_shutdown() -> None:
    scheduler.stop()
    watcher.stop()
    processor.stop()
    logger.info("Service stopped", extra={"status": "stopped"})
