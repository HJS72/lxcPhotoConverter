# lxcPhotoConverter

Production-ready media import and conversion service for Debian Linux in Proxmox LXC.

## Features

- FastAPI backend on Python 3.12
- React + TypeScript + Vite + Material UI dashboard
- SQLite processing history via SQLAlchemy
- Background worker queue + APScheduler full scans
- Live filesystem monitoring with watchdog/inotify
- ExifTool metadata extraction
- ImageMagick HEIC/HEIF to JPG conversion
- Duplicate detection by SHA-256 hash
- Deterministic EXIF-based renaming
- Native Debian deployment in Proxmox LXC
- systemd service units and env file support
- Structured JSON logs for journald/aggregation

## Supported Media

Images: HEIC, HEIF, JPG, JPEG, PNG, TIFF, DNG  
Videos: MOV, MP4, AVI, M4V

## Rename Rule

Timestamp priority:

1. DateTimeOriginal
2. CreateDate
3. MediaCreateDate
4. FileCreateDate

Filename format:

`IMG_YYYYMMDD_HHMMSS.ext`

Collision suffix:

- `IMG_20260731_164530_01.jpg`
- `IMG_20260731_164530_02.jpg`

Two-digit counter is always used.

## Architecture

- `backend/app/main.py`: FastAPI app, startup/shutdown lifecycle
- `backend/app/media.py`: conversion, rename, dedupe, history writes
- `backend/app/watcher.py`: inotify watcher wiring
- `backend/app/scheduler.py`: periodic full scans
- `frontend/src/App.tsx`: status dashboard
- `deploy/systemd/`: native systemd units

## Quick Start (Native Debian in LXC)

```bash
chmod +x scripts/install_debian.sh
chmod +x scripts/check_lxc_prereqs.sh
sudo ./scripts/check_lxc_prereqs.sh
sudo ./scripts/install_debian.sh
sudo cp deploy/lxc-photo-converter.env.example /etc/lxc-photo-converter/lxc-photo-converter.env
sudo systemctl restart lxc-photo-converter.service
```

- Dashboard: `http://<lxc-ip>:8000/`
- API health: `http://<lxc-ip>:8000/api/health`

## SMB/CIFS Share Mounting

Mount shares on host or in container, then point `SOURCE_SHARES` to mounted paths.

Example `/etc/fstab` entry:

```fstab
//nas/photos-in /srv/import/share1 cifs credentials=/root/.smb-photos,iocharset=utf8,uid=photoimport,gid=photoimport,file_mode=0660,dir_mode=0770,vers=3.0,nofail 0 0
//nas/photos-in-2 /srv/import/share2 cifs credentials=/root/.smb-photos,iocharset=utf8,uid=photoimport,gid=photoimport,file_mode=0660,dir_mode=0770,vers=3.0,nofail 0 0
//nas/photos-out /srv/export cifs credentials=/root/.smb-photos,iocharset=utf8,uid=photoimport,gid=photoimport,file_mode=0660,dir_mode=0770,vers=3.0,nofail 0 0
```

## Environment Variables

See:

- `backend/.env.example`
- `deploy/lxc-photo-converter.env.example`

Key values:

- `SOURCE_SHARES` comma-separated mount paths
- `DESTINATION_SHARE` processed output path
- `FAILED_SHARE` failed/duplicate quarantine path
- `SCAN_INTERVAL_SECONDS` periodic rescan interval
- `WORKER_COUNT` concurrent processing workers

Default native values:

- `SOURCE_SHARES=/srv/import/share1,/srv/import/share2`
- `DESTINATION_SHARE=/srv/export`
- `FAILED_SHARE=/srv/failed`

## API Endpoints

- `GET /api/health`
- `GET /api/status`
- `GET /api/history?limit=50`
- `POST /api/scan`

## systemd

Install unit:

```bash
sudo cp deploy/systemd/lxc-photo-converter.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lxc-photo-converter.service
```

View logs:

```bash
journalctl -u lxc-photo-converter.service -f
```
