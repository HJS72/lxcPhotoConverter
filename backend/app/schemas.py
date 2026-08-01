from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


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


class WorkflowCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    source_path: str = Field(min_length=1, max_length=1024)
    destination_path: str = Field(min_length=1, max_length=1024)
    failed_path: str = Field(min_length=1, max_length=1024)
    enabled: bool = True


class WorkflowUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    source_path: str = Field(min_length=1, max_length=1024)
    destination_path: str = Field(min_length=1, max_length=1024)
    failed_path: str = Field(min_length=1, max_length=1024)
    enabled: bool = True


class WorkflowItem(BaseModel):
    id: int
    name: str
    source_path: str
    destination_path: str
    failed_path: str
    enabled: bool
    created_at: datetime
    updated_at: datetime
