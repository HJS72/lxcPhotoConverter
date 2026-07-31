from __future__ import annotations

from sqlalchemy import desc, select

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import ProcessedMedia
from app.schemas import HistoryItem, ScanResponse, StatusResponse

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
