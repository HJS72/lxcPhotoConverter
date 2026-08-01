#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi

if [[ "$#" -ne 4 ]]; then
  echo "Usage: mount_network_drive.sh //server/share /mount/path username password" >&2
  exit 1
fi

SMB_PATH="$1"
MOUNT_PATH="$2"
SMB_USER="$3"
SMB_PASS="$4"

if [[ "${SMB_PATH}" != //*/* ]]; then
  echo "Invalid smb_path: ${SMB_PATH}" >&2
  exit 1
fi

if [[ "${MOUNT_PATH}" != /* ]]; then
  echo "Invalid mount_path: ${MOUNT_PATH}" >&2
  exit 1
fi

if [[ "${SMB_USER}" == *$'\n'* || "${SMB_PASS}" == *$'\n'* ]]; then
  echo "Username/password must not contain newlines" >&2
  exit 1
fi

mkdir -p "${MOUNT_PATH}"

if mountpoint -q "${MOUNT_PATH}"; then
  echo "already mounted: ${MOUNT_PATH}"
  exit 0
fi

CRED_FILE="$(mktemp /run/lxc-photo-converter-cifs-cred.XXXXXX)"
cleanup() {
  rm -f "${CRED_FILE}"
}
trap cleanup EXIT

chmod 600 "${CRED_FILE}"
printf 'username=%s\npassword=%s\n' "${SMB_USER}" "${SMB_PASS}" > "${CRED_FILE}"

mount -t cifs "${SMB_PATH}" "${MOUNT_PATH}" \
  -o "credentials=${CRED_FILE},vers=3.0,uid=photoimport,gid=photoimport,forceuid,forcegid,file_mode=0660,dir_mode=0770,soft,nounix"

echo "mounted ${SMB_PATH} -> ${MOUNT_PATH}"
