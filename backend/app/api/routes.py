from __future__ import annotations

from pathlib import Path

from sqlalchemy import desc, select

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import ProcessedMedia, Workflow
from app.schemas import HistoryItem, ScanResponse, StatusResponse, WorkflowCreate, WorkflowItem, WorkflowUpdate

router = APIRouter()


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
    return StatusResponse(
        queued_files=queue_stats.queued_files,
        workers_alive=queue_stats.workers_alive,
        total_processed=db_stats["total_processed"],
        total_failed=db_stats["total_failed"],
        total_duplicates=db_stats["total_duplicates"],
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

    discovered, queued = app_state.scheduler.enqueue_full_scan()
    return ScanResponse(discovered=discovered, queued=queued)


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
    workflow.enabled = payload.enabled
    db.commit()
    db.refresh(workflow)

    return WorkflowItem(
        id=workflow.id,
        name=workflow.name,
        source_path=workflow.source_path,
        destination_path=workflow.destination_path,
        failed_path=workflow.failed_path,
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
