from __future__ import annotations

from pathlib import Path

from sqlalchemy import delete, desc, select

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import NetworkDrive, ProcessedMedia, Workflow
from app.network_drives import check_network_drive, ensure_mount_path_exists, validate_smb_path
from app.schemas import (
    HistoryItem,
    NetworkDriveClone,
    NetworkDriveCreate,
    NetworkDriveItem,
    NetworkDriveUpdate,
    ScanResponse,
    ScanScheduleResponse,
    ScanScheduleUpdate,
    StatsResetResponse,
    StatusResponse,
    WorkflowCreate,
    WorkflowItem,
    WorkflowUpdate,
)

router = APIRouter()

FIXED_NAMING_PATTERN = "IMG_{timestamp}"
FIXED_TIMESTAMP_FORMAT = "%Y%m%d_%H%M%S"


def get_scan_schedule_response() -> ScanScheduleResponse:
    from app.main import app_state

    return ScanScheduleResponse(
        enabled=app_state.scheduler.is_enabled(),
        interval_seconds=app_state.scheduler.get_interval_seconds(),
        next_scan_at=app_state.scheduler.get_next_scan_time(),
    )


def normalize_extensions(raw: str | None) -> str | None:
    if raw is None:
        return None
    parts = [item.strip().lower() for item in raw.split(",") if item.strip()]
    if not parts:
        return None
    normalized = [item if item.startswith(".") else f".{item}" for item in parts]
    return ",".join(sorted(set(normalized)))


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/status", response_model=StatusResponse)
def status() -> StatusResponse:
    from app.main import app_state

    queue_stats = app_state.processor.get_queue_stats()
    db_stats = app_state.processor.get_db_stats()
    last_scan_at, last_scan_discovered, last_scan_queued, last_scan_trigger = app_state.scheduler.get_last_scan_info()
    return StatusResponse(
        queued_files=queue_stats.queued_files,
        workers_alive=queue_stats.workers_alive,
        total_processed=db_stats["total_processed"],
        total_failed=db_stats["total_failed"],
        total_duplicates=db_stats["total_duplicates"],
        next_scan_at=app_state.scheduler.get_next_scan_time(),
        last_scan_at=last_scan_at,
        last_scan_discovered=last_scan_discovered,
        last_scan_queued=last_scan_queued,
        last_scan_trigger=last_scan_trigger,
        scan_interval_seconds=app_state.scheduler.get_interval_seconds(),
        scan_schedule_enabled=app_state.scheduler.is_enabled(),
    )


@router.get("/history", response_model=list[HistoryItem])
def history(limit: int = 100, db: Session = Depends(get_db)) -> list[HistoryItem]:
    rows = db.scalars(select(ProcessedMedia).order_by(desc(ProcessedMedia.created_at)).limit(limit)).all()
    return [
        HistoryItem(
            id=row.id,
            source_path=row.source_path,
            destination_path=row.destination_path,
            extension=row.extension,
            captured_at=row.captured_at,
            status=row.status,
            error_message=row.error_message,
            created_at=row.created_at,
        )
        for row in rows
    ]


@router.post("/scan", response_model=ScanResponse)
def scan() -> ScanResponse:
    from app.main import app_state

    discovered, queued = app_state.scheduler.enqueue_full_scan(trigger="manual")
    return ScanResponse(discovered=discovered, queued=queued)


@router.get("/scan-schedule", response_model=ScanScheduleResponse)
def get_scan_schedule() -> ScanScheduleResponse:
    return get_scan_schedule_response()


@router.put("/scan-schedule/interval", response_model=ScanScheduleResponse)
def update_scan_interval(payload: ScanScheduleUpdate) -> ScanScheduleResponse:
    from app.main import app_state

    app_state.scheduler.set_interval_seconds(payload.interval_seconds)
    return get_scan_schedule_response()


@router.post("/scan-schedule/start", response_model=ScanScheduleResponse)
def start_scan_schedule() -> ScanScheduleResponse:
    from app.main import app_state

    app_state.scheduler.resume()
    return get_scan_schedule_response()


@router.post("/scan-schedule/stop", response_model=ScanScheduleResponse)
def stop_scan_schedule() -> ScanScheduleResponse:
    from app.main import app_state

    app_state.scheduler.pause()
    return get_scan_schedule_response()


@router.post("/stats/reset", response_model=StatsResetResponse)
def reset_stats(db: Session = Depends(get_db)) -> StatsResetResponse:
    result = db.execute(delete(ProcessedMedia))
    db.commit()
    return StatsResetResponse(status="reset", deleted_rows=int(result.rowcount or 0))


@router.get("/workflows", response_model=list[WorkflowItem])
def list_workflows(db: Session = Depends(get_db)) -> list[WorkflowItem]:
    rows = db.scalars(select(Workflow).order_by(Workflow.created_at.desc())).all()
    return [
        WorkflowItem(
            id=row.id,
            name=row.name,
            source_path=row.source_path,
            destination_path=row.destination_path,
            failed_path=row.failed_path,
            allowed_extensions=row.allowed_extensions,
            enabled=row.enabled,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )
        for row in rows
    ]


@router.post("/workflows", response_model=WorkflowItem)
def create_workflow(payload: WorkflowCreate, db: Session = Depends(get_db)) -> WorkflowItem:
    if db.scalar(select(Workflow).where(Workflow.name == payload.name)):
        raise HTTPException(status_code=409, detail="Workflow name already exists")
    if db.scalar(select(Workflow).where(Workflow.source_path == payload.source_path)):
        raise HTTPException(status_code=409, detail="Workflow source_path already exists")

    workflow = Workflow(
        name=payload.name.strip(),
        source_path=str(Path(payload.source_path).resolve()),
        destination_path=str(Path(payload.destination_path).resolve()),
        failed_path=str(Path(payload.failed_path).resolve()),
        allowed_extensions=normalize_extensions(payload.allowed_extensions),
        naming_pattern=FIXED_NAMING_PATTERN,
        timestamp_format=FIXED_TIMESTAMP_FORMAT,
        enabled=payload.enabled,
    )
    db.add(workflow)
    db.commit()
    db.refresh(workflow)
    return WorkflowItem(
        id=workflow.id,
        name=workflow.name,
        source_path=workflow.source_path,
        destination_path=workflow.destination_path,
        failed_path=workflow.failed_path,
        allowed_extensions=workflow.allowed_extensions,
        enabled=workflow.enabled,
        created_at=workflow.created_at,
        updated_at=workflow.updated_at,
    )


@router.put("/workflows/{workflow_id}", response_model=WorkflowItem)
def update_workflow(workflow_id: int, payload: WorkflowUpdate, db: Session = Depends(get_db)) -> WorkflowItem:
    workflow = db.scalar(select(Workflow).where(Workflow.id == workflow_id))
    if workflow is None:
        raise HTTPException(status_code=404, detail="Workflow not found")

    conflicting_name = db.scalar(select(Workflow).where(Workflow.name == payload.name, Workflow.id != workflow_id))
    if conflicting_name:
        raise HTTPException(status_code=409, detail="Workflow name already exists")

    source_value = str(Path(payload.source_path).resolve())
    conflicting_source = db.scalar(select(Workflow).where(Workflow.source_path == source_value, Workflow.id != workflow_id))
    if conflicting_source:
        raise HTTPException(status_code=409, detail="Workflow source_path already exists")

    workflow.name = payload.name.strip()
    workflow.source_path = source_value
    workflow.destination_path = str(Path(payload.destination_path).resolve())
    workflow.failed_path = str(Path(payload.failed_path).resolve())
    workflow.allowed_extensions = normalize_extensions(payload.allowed_extensions)
    workflow.naming_pattern = FIXED_NAMING_PATTERN
    workflow.timestamp_format = FIXED_TIMESTAMP_FORMAT
    workflow.enabled = payload.enabled
    db.commit()
    db.refresh(workflow)

    return WorkflowItem(
        id=workflow.id,
        name=workflow.name,
        source_path=workflow.source_path,
        destination_path=workflow.destination_path,
        failed_path=workflow.failed_path,
        allowed_extensions=workflow.allowed_extensions,
        enabled=workflow.enabled,
        created_at=workflow.created_at,
        updated_at=workflow.updated_at,
    )


@router.delete("/workflows/{workflow_id}")
def delete_workflow(workflow_id: int, db: Session = Depends(get_db)) -> dict[str, str]:
    workflow = db.scalar(select(Workflow).where(Workflow.id == workflow_id))
    if workflow is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    db.delete(workflow)
    db.commit()
    return {"status": "deleted"}


def to_network_drive_item(row: NetworkDrive) -> NetworkDriveItem:
    return NetworkDriveItem(
        id=row.id,
        name=row.name,
        smb_path=row.smb_path,
        mount_path=row.mount_path,
        username=row.username,
        has_password=bool(row.password),
        enabled=row.enabled,
        connection_status=row.connection_status,
        last_checked_at=row.last_checked_at,
        last_error=row.last_error,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get("/network-drives", response_model=list[NetworkDriveItem])
def list_network_drives(db: Session = Depends(get_db)) -> list[NetworkDriveItem]:
    rows = db.scalars(select(NetworkDrive).order_by(NetworkDrive.created_at.desc())).all()
    return [to_network_drive_item(row) for row in rows]


@router.post("/network-drives", response_model=NetworkDriveItem)
def create_network_drive(payload: NetworkDriveCreate, db: Session = Depends(get_db)) -> NetworkDriveItem:
    if db.scalar(select(NetworkDrive).where(NetworkDrive.name == payload.name.strip())):
        raise HTTPException(status_code=409, detail="Network drive name already exists")
    ok, message = validate_smb_path(payload.smb_path)
    if not ok:
        raise HTTPException(status_code=400, detail=message)
    try:
        mount_path = ensure_mount_path_exists(payload.mount_path)
    except OSError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot create mount_path '{payload.mount_path}': {exc}",
        ) from exc

    drive = NetworkDrive(
        name=payload.name.strip(),
        smb_path=message,
        mount_path=mount_path,
        username=payload.username.strip(),
        password=payload.password,
        enabled=payload.enabled,
        connection_status="unknown",
        last_error=None,
    )
    db.add(drive)
    db.commit()
    db.refresh(drive)
    return to_network_drive_item(drive)


@router.post("/network-drives/{drive_id}/clone", response_model=NetworkDriveItem)
def clone_network_drive(drive_id: int, payload: NetworkDriveClone, db: Session = Depends(get_db)) -> NetworkDriveItem:
    source_drive = db.scalar(select(NetworkDrive).where(NetworkDrive.id == drive_id))
    if source_drive is None:
        raise HTTPException(status_code=404, detail="Network drive not found")

    if db.scalar(select(NetworkDrive).where(NetworkDrive.name == payload.name.strip())):
        raise HTTPException(status_code=409, detail="Network drive name already exists")

    ok, message = validate_smb_path(payload.smb_path)
    if not ok:
        raise HTTPException(status_code=400, detail=message)

    try:
        mount_path = ensure_mount_path_exists(payload.mount_path)
    except OSError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot create mount_path '{payload.mount_path}': {exc}",
        ) from exc

    password = payload.password if payload.password else source_drive.password

    drive = NetworkDrive(
        name=payload.name.strip(),
        smb_path=message,
        mount_path=mount_path,
        username=payload.username.strip(),
        password=password,
        enabled=payload.enabled,
        connection_status="unknown",
        last_error=None,
    )
    db.add(drive)
    db.commit()
    db.refresh(drive)
    return to_network_drive_item(drive)


@router.put("/network-drives/{drive_id}", response_model=NetworkDriveItem)
def update_network_drive(drive_id: int, payload: NetworkDriveUpdate, db: Session = Depends(get_db)) -> NetworkDriveItem:
    drive = db.scalar(select(NetworkDrive).where(NetworkDrive.id == drive_id))
    if drive is None:
        raise HTTPException(status_code=404, detail="Network drive not found")

    conflicting_name = db.scalar(select(NetworkDrive).where(NetworkDrive.name == payload.name.strip(), NetworkDrive.id != drive_id))
    if conflicting_name:
        raise HTTPException(status_code=409, detail="Network drive name already exists")

    ok, message = validate_smb_path(payload.smb_path)
    if not ok:
        raise HTTPException(status_code=400, detail=message)
    try:
        mount_path = ensure_mount_path_exists(payload.mount_path)
    except OSError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot create mount_path '{payload.mount_path}': {exc}",
        ) from exc

    drive.name = payload.name.strip()
    drive.smb_path = message
    drive.mount_path = mount_path
    drive.username = payload.username.strip()
    if payload.password:
        drive.password = payload.password
    drive.enabled = payload.enabled
    db.commit()
    db.refresh(drive)
    return to_network_drive_item(drive)


@router.post("/network-drives/{drive_id}/check", response_model=NetworkDriveItem)
def check_network_drive_connection(drive_id: int, db: Session = Depends(get_db)) -> NetworkDriveItem:
    drive = db.scalar(select(NetworkDrive).where(NetworkDrive.id == drive_id))
    if drive is None:
        raise HTTPException(status_code=404, detail="Network drive not found")

    result = check_network_drive(drive.smb_path, drive.username, drive.password)
    drive.connection_status = result.status
    drive.last_checked_at = result.checked_at
    drive.last_error = None if result.connected else result.message
    db.commit()
    db.refresh(drive)
    return to_network_drive_item(drive)


@router.delete("/network-drives/{drive_id}")
def delete_network_drive(drive_id: int, db: Session = Depends(get_db)) -> dict[str, str]:
    drive = db.scalar(select(NetworkDrive).where(NetworkDrive.id == drive_id))
    if drive is None:
        raise HTTPException(status_code=404, detail="Network drive not found")
    db.delete(drive)
    db.commit()
    return {"status": "deleted"}
