#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="/opt/lxc-photo-converter"
SERVICE_USER="photoimport"
ENV_DIR="/etc/lxc-photo-converter"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root"
  exit 1
fi

apt-get update
apt-get install -y --no-install-recommends \
  python3-pip exiftool imagemagick libheif1 cifs-utils nodejs npm rsync ca-certificates

if ! command -v python3.12 >/dev/null 2>&1; then
  apt-get install -y --no-install-recommends python3.12 python3.12-venv || true
fi

if ! command -v python3.12 >/dev/null 2>&1; then
  echo "python3.12 not available in current apt sources"
  echo "Enable repository providing Python 3.12, then rerun installer"
  exit 1
fi

if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

mkdir -p "${PROJECT_ROOT}" "${ENV_DIR}" \
  "${PROJECT_ROOT}/backend/data" \
  "/srv/import/share1" \
  "/srv/import/share2" \
  "/srv/export" \
  "/srv/failed"

rsync -a --delete "${SOURCE_ROOT}/backend/" "${PROJECT_ROOT}/backend/"
rsync -a --delete "${SOURCE_ROOT}/frontend/" "${PROJECT_ROOT}/frontend/"
rsync -a --delete "${SOURCE_ROOT}/deploy/" "${PROJECT_ROOT}/deploy/"
rsync -a --delete "${SOURCE_ROOT}/scripts/" "${PROJECT_ROOT}/scripts/"

python3.12 -m venv "${PROJECT_ROOT}/.venv"
"${PROJECT_ROOT}/.venv/bin/pip" install --upgrade pip
"${PROJECT_ROOT}/.venv/bin/pip" install -r "${PROJECT_ROOT}/backend/requirements.txt"

pushd "${PROJECT_ROOT}/frontend" >/dev/null
npm install
npm run build
popd >/dev/null

if [[ ! -f "${ENV_DIR}/lxc-photo-converter.env" ]]; then
  cp "${PROJECT_ROOT}/deploy/lxc-photo-converter.env.example" "${ENV_DIR}/lxc-photo-converter.env"
fi

cp "${PROJECT_ROOT}/deploy/systemd/lxc-photo-converter.service" /etc/systemd/system/

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${PROJECT_ROOT}"
chown -R "${SERVICE_USER}:${SERVICE_USER}" /srv/import /srv/export /srv/failed
chmod +x "${PROJECT_ROOT}/scripts/install_debian.sh"

systemctl daemon-reload
systemctl enable --now lxc-photo-converter.service

echo "Install complete. Edit ${ENV_DIR}/lxc-photo-converter.env and restart service if needed."
