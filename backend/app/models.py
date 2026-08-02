from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class ProcessedMedia(Base):
    __tablename__ = "processed_media"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_path: Mapped[str] = mapped_column(String(1024), index=True)
    source_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    destination_path: Mapped[str | None] = mapped_column(String(1024), unique=True, nullable=True)
    extension: Mapped[str] = mapped_column(String(16))
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)
    status: Mapped[str] = mapped_column(String(32), index=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), default=lambda: datetime.now(UTC).replace(tzinfo=None))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False),
        default=lambda: datetime.now(UTC).replace(tzinfo=None),
        onupdate=lambda: datetime.now(UTC).replace(tzinfo=None),
    )


class Workflow(Base):
    __tablename__ = "workflows"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    source_path: Mapped[str] = mapped_column(String(1024), unique=True, index=True)
    destination_path: Mapped[str] = mapped_column(String(1024))
    failed_path: Mapped[str] = mapped_column(String(1024))
    allowed_extensions: Mapped[str | None] = mapped_column(String(512), nullable=True)
    naming_pattern: Mapped[str] = mapped_column(String(128), default="IMG_{timestamp}")
    timestamp_format: Mapped[str] = mapped_column(String(64), default="%Y%m%d_%H%M%S")
    enabled: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), default=lambda: datetime.now(UTC).replace(tzinfo=None))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False),
        default=lambda: datetime.now(UTC).replace(tzinfo=None),
        onupdate=lambda: datetime.now(UTC).replace(tzinfo=None),
    )


class NetworkDrive(Base):
    __tablename__ = "network_drives"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    smb_path: Mapped[str] = mapped_column(String(1024), index=True)
    mount_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    username: Mapped[str] = mapped_column(String(256))
    password: Mapped[str] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(default=True)
    folder_check_enabled: Mapped[bool] = mapped_column(default=False)
    connection_status: Mapped[str] = mapped_column(String(32), default="unknown")
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), default=lambda: datetime.now(UTC).replace(tzinfo=None))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False),
        default=lambda: datetime.now(UTC).replace(tzinfo=None),
        onupdate=lambda: datetime.now(UTC).replace(tzinfo=None),
    )
