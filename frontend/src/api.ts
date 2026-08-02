export type StatusResponse = {
  queued_files: number;
  workers_alive: number;
  total_processed: number;
  total_failed: number;
  total_duplicates: number;
  next_scan_at: string | null;
  last_scan_at: string | null;
  last_scan_discovered: number;
  last_scan_queued: number;
  last_scan_trigger: string | null;
  scan_interval_seconds: number;
  scan_schedule_enabled: boolean;
  workflow_sources: WorkflowSourceStatusItem[];
};

export type WorkflowSourceStatusItem = {
  workflow_id: number;
  workflow_name: string;
  source_path: string;
  enabled: boolean;
  files_total: number;
  queued_files: number;
  processed_files: number;
  failed_files: number;
  duplicate_files: number;
};

export type ScanScheduleResponse = {
  enabled: boolean;
  interval_seconds: number;
  next_scan_at: string | null;
};

export type StatsResetResponse = {
  status: string;
  deleted_rows: number;
};

export type HistoryItem = {
  id: number;
  source_path: string;
  destination_path: string | null;
  extension: string;
  captured_at: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
};

export type WorkflowItem = {
  id: number;
  name: string;
  source_path: string;
  destination_path: string;
  failed_path: string;
  allowed_extensions: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type WorkflowPayload = {
  name: string;
  source_path: string;
  destination_path: string;
  failed_path: string;
  allowed_extensions: string;
  enabled: boolean;
};

export type NetworkDriveItem = {
  id: number;
  name: string;
  smb_path: string;
  mount_path: string | null;
  username: string;
  has_password: boolean;
  enabled: boolean;
  folder_check_enabled: boolean;
  connection_status: string;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type NetworkDrivePayload = {
  name: string;
  smb_path: string;
  mount_path: string;
  username: string;
  password: string;
  enabled: boolean;
};

export type NetworkDriveClonePayload = {
  name: string;
  smb_path: string;
  mount_path: string;
  username: string;
  password?: string;
  enabled: boolean;
};

export type NetworkShareDiscoveryPayload = {
  server: string;
  username: string;
  password: string;
};

export type FolderAuditPayload = {
  root_path: string;
  max_results?: number;
};

export type FolderDuplicateGroup = {
  sha256: string;
  file_count: number;
  size_bytes: number;
  paths: string[];
};

export type FolderAuditResponse = {
  root_path: string;
  scanned_folders: number;
  scanned_files: number;
  duration_ms: number;
  heic_count: number;
  wrong_name_count: number;
  duplicate_groups_count: number;
  duplicate_files_count: number;
  checksum_cache_hits: number;
  checksum_computed: number;
  checksum_cache_entries: number;
  heic_files: string[];
  wrong_name_files: string[];
  duplicate_groups: FolderDuplicateGroup[];
  scan_errors: string[];
};

export type FolderCheckConfigResponse = {
  drive_id: number | null;
  drive_name: string | null;
  root_path: string | null;
};

export type FolderCheckSummary = {
  files_total: number;
  directories_total: number;
  duplicates_total: number;
  wrong_name_total: number;
  wrong_extension_total: number;
  exif_invalid_total: number;
  never_scanned_total: number;
  changed_total: number;
};

export type FolderCheckFileItem = {
  relative_path: string;
  directory: string;
  filename: string;
  extension: string;
  size_bytes: number;
  modified_at: string;
  sha256: string | null;
  duplicate: boolean;
  wrong_name: boolean;
  wrong_extension: boolean;
  exif_invalid: boolean;
  never_scanned: boolean;
  changed_since_last_scan: boolean;
  exif_capture_at: string | null;
};

export type FolderCheckScanResponse = {
  root_path: string;
  scanned_at: string;
  duration_ms: number;
  summary: FolderCheckSummary;
  files: FolderCheckFileItem[];
  scan_errors: string[];
};

export type FolderCheckScanStartResponse = {
  job_id: string;
  status: string;
  message: string;
};

export type FolderCheckScanStatusResponse = {
  job_id: string | null;
  status: string;
  root_path: string | null;
  started_at: string | null;
  finished_at: string | null;
  scanned_directories: number;
  scanned_files: number;
  max_files: number;
  progress_percent: number;
  current_item: string | null;
  error_message: string | null;
  result: FolderCheckScanResponse | null;
};

export type FolderCheckResolveDuplicatePayload = {
  sha256: string;
  keep_relative_path: string;
};

export type FolderCheckResolveDuplicateResponse = {
  kept_relative_path: string;
  deleted_count: number;
  skipped_missing_count: number;
  errors: string[];
  result: FolderCheckScanResponse;
};

const readJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = "";
    try {
      const payload = (await response.json()) as { detail?: string };
      if (typeof payload?.detail === "string" && payload.detail.trim()) {
        detail = payload.detail.trim();
      }
    } catch {
      // ignore parse errors and fall back to status-only message
    }
    throw new Error(
      detail ? `Request failed with ${response.status}: ${detail}` : `Request failed with ${response.status}`
    );
  }
  return (await response.json()) as T;
};

export const fetchStatus = () => readJson<StatusResponse>("/api/status");
export const fetchHistory = () => readJson<HistoryItem[]>("/api/history?limit=50");
export const triggerScan = () => readJson<{ discovered: number; queued: number }>("/api/scan", { method: "POST" });
export const fetchScanSchedule = () => readJson<ScanScheduleResponse>("/api/scan-schedule");
export const updateScanInterval = (intervalSeconds: number) =>
  readJson<ScanScheduleResponse>("/api/scan-schedule/interval", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interval_seconds: intervalSeconds }),
  });
export const startScanSchedule = () =>
  readJson<ScanScheduleResponse>("/api/scan-schedule/start", { method: "POST" });
export const stopScanSchedule = () =>
  readJson<ScanScheduleResponse>("/api/scan-schedule/stop", { method: "POST" });
export const resetStats = () => readJson<StatsResetResponse>("/api/stats/reset", { method: "POST" });
export const fetchWorkflows = () => readJson<WorkflowItem[]>("/api/workflows");
export const createWorkflow = (payload: WorkflowPayload) =>
  readJson<WorkflowItem>("/api/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
export const updateWorkflow = (workflowId: number, payload: WorkflowPayload) =>
  readJson<WorkflowItem>(`/api/workflows/${workflowId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
export const deleteWorkflow = (workflowId: number) =>
  readJson<{ status: string }>(`/api/workflows/${workflowId}`, {
    method: "DELETE",
  });

export const fetchNetworkDrives = () => readJson<NetworkDriveItem[]>("/api/network-drives");
export const fetchNetworkDriveFolders = (driveId: number) =>
  readJson<string[]>(`/api/network-drives/${driveId}/folders`);
export const discoverNetworkDriveShares = (payload: NetworkShareDiscoveryPayload) =>
  readJson<string[]>("/api/network-drives/discover-shares", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
export const createNetworkDrive = (payload: NetworkDrivePayload) =>
  readJson<NetworkDriveItem>("/api/network-drives", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
export const updateNetworkDrive = (driveId: number, payload: NetworkDrivePayload) =>
  readJson<NetworkDriveItem>(`/api/network-drives/${driveId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
export const cloneNetworkDrive = (driveId: number, payload: NetworkDriveClonePayload) =>
  readJson<NetworkDriveItem>(`/api/network-drives/${driveId}/clone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
export const checkNetworkDrive = (driveId: number) =>
  readJson<NetworkDriveItem>(`/api/network-drives/${driveId}/check`, {
    method: "POST",
  });
export const mountNetworkDrive = (driveId: number) =>
  readJson<NetworkDriveItem>(`/api/network-drives/${driveId}/mount`, {
    method: "POST",
  });
export const deleteNetworkDrive = (driveId: number) =>
  readJson<{ status: string }>(`/api/network-drives/${driveId}`, {
    method: "DELETE",
  });

export const setNetworkDriveFolderCheck = (driveId: number, selected: boolean) =>
  readJson<NetworkDriveItem>(`/api/network-drives/${driveId}/folder-check`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selected }),
  });

export const runFolderAudit = (payload: FolderAuditPayload) =>
  readJson<FolderAuditResponse>("/api/folder-audit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

export const fetchFolderCheckConfig = () => readJson<FolderCheckConfigResponse>("/api/folder-check/config");
export const runFolderCheckScan = () =>
  readJson<FolderCheckScanResponse>("/api/folder-check/scan", {
    method: "POST",
  });
export const startFolderCheckScan = () =>
  readJson<FolderCheckScanStartResponse>("/api/folder-check/scan/start", {
    method: "POST",
  });
export const fetchFolderCheckScanStatus = () => readJson<FolderCheckScanStatusResponse>("/api/folder-check/scan/status");
export const fetchFolderCheckLatest = () => readJson<FolderCheckScanResponse>("/api/folder-check/latest");
export const resolveFolderCheckDuplicateGroup = (payload: FolderCheckResolveDuplicatePayload) =>
  readJson<FolderCheckResolveDuplicateResponse>("/api/folder-check/duplicates/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
export const folderCheckPreviewUrl = (relativePath: string) =>
  `/api/folder-check/preview?relative_path=${encodeURIComponent(relativePath)}`;
