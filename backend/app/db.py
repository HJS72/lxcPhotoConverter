from __future__ import annotations

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


settings = get_settings()
engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False} if settings.database_url.startswith("sqlite") else {},
)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


def init_db() -> None:
    from app import models

    models.Base.metadata.create_all(bind=engine)

    with engine.begin() as connection:
        table_exists = connection.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='workflows'")
        ).first()
        if not table_exists:
            return

        existing_columns = {
            row[1] for row in connection.execute(text("PRAGMA table_info(workflows)"))
        }
        if "allowed_extensions" not in existing_columns:
            connection.execute(text("ALTER TABLE workflows ADD COLUMN allowed_extensions VARCHAR(512)"))
        if "naming_pattern" not in existing_columns:
            connection.execute(
                text("ALTER TABLE workflows ADD COLUMN naming_pattern VARCHAR(128) DEFAULT 'IMG_{timestamp}'")
            )
        if "timestamp_format" not in existing_columns:
            connection.execute(
                text("ALTER TABLE workflows ADD COLUMN timestamp_format VARCHAR(64) DEFAULT '%Y%m%d_%H%M%S'")
            )

        network_table_exists = connection.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='network_drives'")
        ).first()
        if network_table_exists and settings.database_url.startswith("sqlite"):
            index_rows = connection.execute(text("PRAGMA index_list('network_drives')")).fetchall()
            smb_path_is_unique = False
            for row in index_rows:
                index_name = row[1]
                is_unique = bool(row[2])
                if not is_unique:
                    continue
                index_columns = connection.execute(text(f"PRAGMA index_info('{index_name}')")).fetchall()
                if any(column[2] == "smb_path" for column in index_columns):
                    smb_path_is_unique = True
                    break

            if smb_path_is_unique:
                connection.execute(text("""
                    CREATE TABLE network_drives_new (
                        id INTEGER PRIMARY KEY,
                        name VARCHAR(128) NOT NULL UNIQUE,
                        smb_path VARCHAR(1024) NOT NULL,
                        mount_path VARCHAR(1024),
                        username VARCHAR(256) NOT NULL,
                        password TEXT NOT NULL,
                        enabled BOOLEAN NOT NULL,
                        connection_status VARCHAR(32) NOT NULL,
                        last_checked_at DATETIME,
                        last_error TEXT,
                        created_at DATETIME NOT NULL,
                        updated_at DATETIME NOT NULL
                    )
                """))
                connection.execute(text("""
                    INSERT INTO network_drives_new (
                        id, name, smb_path, mount_path, username, password, enabled,
                        connection_status, last_checked_at, last_error, created_at, updated_at
                    )
                    SELECT
                        id, name, smb_path, mount_path, username, password, enabled,
                        connection_status, last_checked_at, last_error, created_at, updated_at
                    FROM network_drives
                """))
                connection.execute(text("DROP TABLE network_drives"))
                connection.execute(text("ALTER TABLE network_drives_new RENAME TO network_drives"))
                connection.execute(text("CREATE INDEX IF NOT EXISTS ix_network_drives_smb_path ON network_drives (smb_path)"))
