from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes import router
from app.config import Settings, get_settings
from app.db import init_db
from app.logging_config import configure_logging
from app.media import MediaProcessor
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


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    processor.start()
    watcher.start(settings.source_shares, recursive=settings.observer_recursive)
    scheduler.start()
    scheduler.enqueue_full_scan()
    logger.info("Service started", extra={"status": "started"})


@app.on_event("shutdown")
def on_shutdown() -> None:
    scheduler.stop()
    watcher.stop()
    processor.stop()
    logger.info("Service stopped", extra={"status": "stopped"})
