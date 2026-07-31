from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class StatusResponse(BaseModel):
    queued_files: int
    workers_alive: int
    total_processed: int
    total_failed: int
    total_duplicates: int


class HistoryItem(BaseModel):
    id: int
    source_path: str
    destination_path: str | None
    extension: str
    captured_at: datetime | None
    status: str
    error_message: str | None
    created_at: datetime


class ScanResponse(BaseModel):
    discovered: int
    queued: int
