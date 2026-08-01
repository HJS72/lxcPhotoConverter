#!/usr/bin/env bash
set -euo pipefail

required_cmds=(python3 exiftool magick systemctl)
required_paths=(/srv/import/share1 /srv/import/share2 /srv/export /srv/failed)

echo "Checking required commands..."
for cmd in "${required_cmds[@]}"; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing command: ${cmd}"
    exit 1
  fi
  echo "OK: ${cmd}"
done

python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' || {
  echo "Python version too old. Need >= 3.12"
  exit 1
}
echo "OK: python >= 3.12"

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
