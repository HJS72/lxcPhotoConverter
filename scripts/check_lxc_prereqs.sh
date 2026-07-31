#!/usr/bin/env bash
set -euo pipefail

required_cmds=(python3.12 exiftool magick systemctl)
required_paths=(/srv/import/share1 /srv/import/share2 /srv/export /srv/failed)

echo "Checking required commands..."
for cmd in "${required_cmds[@]}"; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing command: ${cmd}"
    exit 1
  fi
  echo "OK: ${cmd}"
done

echo "Checking required paths..."
for path in "${required_paths[@]}"; do
  if [[ ! -d "${path}" ]]; then
    echo "Missing directory: ${path}"
    exit 1
  fi
  if ! mountpoint -q "${path}"; then
    echo "Warning: ${path} is not a mount point"
  else
    echo "OK mount: ${path}"
  fi
done

echo "All checks complete"
