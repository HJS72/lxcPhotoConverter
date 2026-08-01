from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class StatusResponse(BaseModel):
    queued_files: int
    workers_alive: int
    total_processed: int
    total_failed: int
    total_duplicates: int
    next_scan_at: datetime | None
    last_scan_at: datetime | None
    last_scan_discovered: int
    last_scan_queued: int
    last_scan_trigger: str | None
    scan_interval_seconds: int
    scan_schedule_enabled: bool
    workflow_sources: list["WorkflowSourceStatusItem"]


class WorkflowSourceStatusItem(BaseModel):
    workflow_id: int
    workflow_name: str
    source_path: str
    enabled: bool
    files_total: int
    queued_files: int
    processed_files: int
    failed_files: int
    duplicate_files: int


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


class StatsResetResponse(BaseModel):
    status: str
    deleted_rows: int


class ScanScheduleUpdate(BaseModel):
    interval_seconds: int = Field(ge=1, le=86400)


class ScanScheduleResponse(BaseModel):
    enabled: bool
    interval_seconds: int
    next_scan_at: datetime | None


class WorkflowCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    source_path: str = Field(min_length=1, max_length=1024)
    destination_path: str = Field(min_length=1, max_length=1024)
    failed_path: str = Field(min_length=1, max_length=1024)
    allowed_extensions: str | None = Field(default=None, max_length=512)
    enabled: bool = True


class WorkflowUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    source_path: str = Field(min_length=1, max_length=1024)
    destination_path: str = Field(min_length=1, max_length=1024)
    failed_path: str = Field(min_length=1, max_length=1024)
    allowed_extensions: str | None = Field(default=None, max_length=512)
    enabled: bool = True


class WorkflowItem(BaseModel):
    id: int
    name: str
    source_path: str
    destination_path: str
    failed_path: str
    allowed_extensions: str | None
    enabled: bool
    created_at: datetime
    updated_at: datetime


class NetworkDriveCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    smb_path: str = Field(min_length=1, max_length=1024)
    mount_path: str | None = Field(default=None, max_length=1024)
    username: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=1, max_length=512)
    enabled: bool = True


class NetworkDriveUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    smb_path: str = Field(min_length=1, max_length=1024)
    mount_path: str | None = Field(default=None, max_length=1024)
    username: str = Field(min_length=1, max_length=256)
    password: str | None = Field(default=None, max_length=512)
    enabled: bool = True


class NetworkDriveClone(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    smb_path: str = Field(min_length=1, max_length=1024)
    mount_path: str | None = Field(default=None, max_length=1024)
    username: str = Field(min_length=1, max_length=256)
    password: str | None = Field(default=None, max_length=512)
    enabled: bool = True


class NetworkShareDiscoveryRequest(BaseModel):
    server: str = Field(min_length=1, max_length=255)
    username: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=1, max_length=512)


class NetworkDriveItem(BaseModel):
    id: int
    name: str
    smb_path: str
    mount_path: str | None
    username: str
    has_password: bool
    enabled: bool
    connection_status: str
    last_checked_at: datetime | None
    last_error: str | None
    created_at: datetime
    updated_at: datetime
