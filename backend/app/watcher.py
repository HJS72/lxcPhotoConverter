from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable

from watchdog.events import FileCreatedEvent, FileMovedEvent, FileSystemEventHandler
from watchdog.observers import Observer

logger = logging.getLogger(__name__)


class MediaEventHandler(FileSystemEventHandler):
    def __init__(self, callback: Callable[[Path], bool]):
        self.callback = callback

    def on_created(self, event: FileCreatedEvent) -> None:
        if event.is_directory:
            return
        queued = self.callback(Path(event.src_path))
        if queued:
            logger.info("Queued new file", extra={"source_path": event.src_path, "status": "queued"})

    def on_moved(self, event: FileMovedEvent) -> None:
        if event.is_directory:
            return
        queued = self.callback(Path(event.dest_path))
        if queued:
            logger.info("Queued moved file", extra={"source_path": event.dest_path, "status": "queued"})


class ShareWatcher:
    def __init__(self, callback: Callable[[Path], bool]):
        self._callback = callback
        self._observer = Observer()

    def start(self, watch_paths: list[Path], recursive: bool = True) -> None:
        event_handler = MediaEventHandler(self._callback)
        for watch_path in watch_paths:
            watch_path.mkdir(parents=True, exist_ok=True)
            self._observer.schedule(event_handler, str(watch_path), recursive=recursive)
            logger.info("Watching share", extra={"source_path": str(watch_path), "status": "watching"})
        self._observer.start()

    def stop(self) -> None:
        self._observer.stop()
        self._observer.join(timeout=5)
