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
    folder_check_enabled: bool
    connection_status: str
    last_checked_at: datetime | None
    last_error: str | None
    created_at: datetime
    updated_at: datetime


class NetworkDriveFolderCheckUpdate(BaseModel):
    selected: bool = True


class FolderAuditRequest(BaseModel):
    root_path: str = Field(min_length=1, max_length=1024)
    max_results: int = Field(default=200, ge=1, le=2000)


class FolderDuplicateGroup(BaseModel):
    sha256: str
    file_count: int
    size_bytes: int
    paths: list[str]


class FolderAuditResponse(BaseModel):
    root_path: str
    scanned_folders: int
    scanned_files: int
    duration_ms: int
    heic_count: int
    wrong_name_count: int
    duplicate_groups_count: int
    duplicate_files_count: int
    checksum_cache_hits: int
    checksum_computed: int
    checksum_cache_entries: int
    heic_files: list[str]
    wrong_name_files: list[str]
    duplicate_groups: list[FolderDuplicateGroup]
    scan_errors: list[str]


class FolderCheckSummary(BaseModel):
    files_total: int
    directories_total: int
    duplicates_total: int
    wrong_name_total: int
    wrong_extension_total: int
    exif_invalid_total: int
    never_scanned_total: int
    changed_total: int


class FolderCheckFileItem(BaseModel):
    relative_path: str
    directory: str
    filename: str
    extension: str
    size_bytes: int
    modified_at: datetime
    sha256: str | None
    duplicate: bool
    wrong_name: bool
    wrong_extension: bool
    exif_invalid: bool
    never_scanned: bool
    changed_since_last_scan: bool
    exif_capture_at: datetime | None


class FolderCheckScanResponse(BaseModel):
    root_path: str
    scanned_at: datetime
    duration_ms: int
    summary: FolderCheckSummary
    files: list[FolderCheckFileItem]
    scan_errors: list[str]


class FolderCheckConfigResponse(BaseModel):
    drive_id: int | None
    drive_name: str | None
    root_path: str | None


class FolderCheckScanStartResponse(BaseModel):
    job_id: str
    status: str
    message: str


class FolderCheckScanStatusResponse(BaseModel):
    job_id: str | None
    status: str
    root_path: str | None
    started_at: datetime | None
    finished_at: datetime | None
    scanned_directories: int
    scanned_files: int
    max_files: int
    progress_percent: int
    current_item: str | None
    error_message: str | None
    result: FolderCheckScanResponse | None


class FolderCheckResolveDuplicateRequest(BaseModel):
    sha256: str = Field(min_length=16, max_length=128)
    keep_relative_path: str = Field(min_length=1, max_length=4096)


class FolderCheckResolveDuplicateResponse(BaseModel):
    kept_relative_path: str
    deleted_count: int
    skipped_missing_count: int
    errors: list[str]
    result: FolderCheckScanResponse
