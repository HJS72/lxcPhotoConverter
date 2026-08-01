from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "lxcPhotoConverter"
    api_prefix: str = "/api"
    database_url: str = "sqlite:///./data/app.db"
    log_level: str = "INFO"
    source_shares: list[Path] | str = Field(default_factory=lambda: [Path("/srv/import/share1"), Path("/srv/import/share2")])
    destination_share: Path = Path("/srv/export")
    failed_share: Path = Path("/srv/failed")
    scan_interval_seconds: int = 120
    observer_recursive: bool = True
    exiftool_path: str = "exiftool"
    magick_path: str = "magick"
    worker_count: int = 2
    timezone: str = "UTC"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @field_validator("source_shares", mode="before")
    @classmethod
    def parse_source_shares(cls, value: object) -> list[Path]:
        if isinstance(value, str):
            if value.strip().startswith("["):
                try:
                    parsed = json.loads(value)
                    if isinstance(parsed, list):
                        return [Path(str(item)) for item in parsed]
                except json.JSONDecodeError:
                    pass
            items = [item.strip() for item in value.split(",") if item.strip()]
            return [Path(item) for item in items]
        if isinstance(value, list):
            return [Path(str(item)) for item in value]
        return [Path("/srv/import/share1"), Path("/srv/import/share2")]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
