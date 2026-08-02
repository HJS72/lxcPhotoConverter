import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  AppBar,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Container,
  CssBaseline,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Snackbar,
  Switch,
  Tab,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Toolbar,
  Typography,
  MenuItem,
  LinearProgress,
} from "@mui/material";
import DarkModeRoundedIcon from "@mui/icons-material/DarkModeRounded";
import LightModeRoundedIcon from "@mui/icons-material/LightModeRounded";
import AutorenewRoundedIcon from "@mui/icons-material/AutorenewRounded";
import { ThemeProvider } from "@mui/material/styles";

import {
  checkNetworkDrive,
  cloneNetworkDrive,
  createWorkflow,
  createNetworkDrive,
  discoverNetworkDriveShares,
  deleteNetworkDrive,
  FolderCheckConfigResponse,
  FolderCheckFileItem,
  FolderCheckResolveDuplicateResponse,
  FolderCheckScanStatusResponse,
  FolderCheckScanResponse,
  fetchFolderCheckScanStatus,
  fetchFolderCheckConfig,
  fetchFolderCheckLatest,
  folderCheckPreviewUrl,
  resolveFolderCheckDuplicateGroup,
  deleteWorkflow,
  fetchHistory,
  fetchNetworkDrives,
  fetchNetworkDriveFolders,
  fetchStatus,
  fetchWorkflows,
  HistoryItem,
  NetworkDriveItem,
  NetworkDrivePayload,
  resetStats,
  startFolderCheckScan,
  setNetworkDriveFolderCheck,
  StatusResponse,
  startScanSchedule,
  stopScanSchedule,
  triggerScan,
  mountNetworkDrive,
  updateScanInterval,
  updateNetworkDrive,
  updateWorkflow,
  WorkflowItem,
  WorkflowPayload,
} from "./api";
import { useAppTheme } from "./theme";

const formatTimestamp = (value: string | null) => {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

type WorkflowPathField = "source_path" | "destination_path" | "failed_path";

type WorkflowPathSelection = {
  driveId: number | null;
  subfolder: string;
};

type WorkflowFolderTreeNode = {
  name: string;
  path: string;
  children: WorkflowFolderTreeNode[];
};

type FolderCheckTreeNode = {
  name: string;
  path: string;
  children: FolderCheckTreeNode[];
};

type HistoryTab = "failed" | "duplicate" | "processed";

const workflowPathFieldLabels: Record<WorkflowPathField, string> = {
  source_path: "Source",
  destination_path: "Destination",
  failed_path: "Failed",
};

const normalizeSubfolder = (value: string) => value.trim().replace(/^\/+/, "").replace(/\/+$/, "");

const composeWorkflowPath = (drive: NetworkDriveItem | null, subfolder: string) => {
  const normalizedSubfolder = normalizeSubfolder(subfolder);
  if (drive?.mount_path) {
    return normalizedSubfolder ? `${drive.mount_path}/${normalizedSubfolder}` : drive.mount_path;
  }
  return normalizedSubfolder;
};

const extractServerFromSmbPath = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("//")) {
    return "";
  }
  const parts = trimmed.slice(2).split("/").filter(Boolean);
  return parts[0] ?? "";
};

const resolveWorkflowPathSelection = (path: string, drives: NetworkDriveItem[]): WorkflowPathSelection => {
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return { driveId: null, subfolder: "" };
  }

  const match = drives
    .filter((drive) => {
      const mountPath = drive.mount_path?.trim();
      return Boolean(mountPath && (normalizedPath === mountPath || normalizedPath.startsWith(`${mountPath}/`)));
    })
    .sort((left, right) => (right.mount_path?.length ?? 0) - (left.mount_path?.length ?? 0))[0];

  if (!match?.mount_path) {
    return { driveId: null, subfolder: normalizedPath };
  }

  const subfolder = normalizedPath === match.mount_path ? "" : normalizedPath.slice(match.mount_path.length + 1);
  return { driveId: match.id, subfolder: normalizeSubfolder(subfolder) };
};

const sortByName = <T extends { name: string }>(items: T[]) =>
  [...items].sort((left, right) => left.name.localeCompare(right.name));

const buildWorkflowFolderTree = (folders: string[]): WorkflowFolderTreeNode[] => {
  type MutableNode = {
    name: string;
    path: string;
    children: Map<string, MutableNode>;
  };

  const root: MutableNode = { name: "", path: "", children: new Map() };

  for (const rawFolder of folders) {
    const normalized = normalizeSubfolder(rawFolder);
    if (!normalized) {
      continue;
    }

    let cursor = root;
    let currentPath = "";
    for (const segment of normalized.split("/").filter(Boolean)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = cursor.children.get(segment);
      if (existing) {
        cursor = existing;
        continue;
      }

      const created: MutableNode = { name: segment, path: currentPath, children: new Map() };
      cursor.children.set(segment, created);
      cursor = created;
    }
  }

  const toTree = (nodes: Map<string, MutableNode>): WorkflowFolderTreeNode[] =>
    [...nodes.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((node) => ({
        name: node.name,
        path: node.path,
        children: toTree(node.children),
      }));

  return toTree(root.children);
};

const buildFolderCheckTree = (files: FolderCheckFileItem[]): FolderCheckTreeNode[] => {
  type MutableNode = {
    name: string;
    path: string;
    children: Map<string, MutableNode>;
  };

  const root: MutableNode = { name: "", path: "", children: new Map() };

  for (const file of files) {
    const segments = file.directory.split("/").filter(Boolean);
    let cursor = root;
    let currentPath = "";
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = cursor.children.get(segment);
      if (existing) {
        cursor = existing;
        continue;
      }
      const created: MutableNode = { name: segment, path: currentPath, children: new Map() };
      cursor.children.set(segment, created);
      cursor = created;
    }
  }

  const toTree = (nodes: Map<string, MutableNode>): FolderCheckTreeNode[] =>
    [...nodes.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((node) => ({
        name: node.name,
        path: node.path,
        children: toTree(node.children),
      }));

  return toTree(root.children);
};

export const App = () => {
  const { theme, mode, toggleMode } = useAppTheme();
  const [tab, setTab] = useState<"dashboard" | "admin" | "folderCheck">("dashboard");
  const [historyTab, setHistoryTab] = useState<HistoryTab>("failed");
  const [folderCheckLoading, setFolderCheckLoading] = useState(false);
  const [folderCheckData, setFolderCheckData] = useState<FolderCheckScanResponse | null>(null);
  const [folderCheckConfig, setFolderCheckConfig] = useState<FolderCheckConfigResponse | null>(null);
  const [folderCheckSelectedDirectory, setFolderCheckSelectedDirectory] = useState("");
  const [folderCheckSelectedFile, setFolderCheckSelectedFile] = useState<FolderCheckFileItem | null>(null);
  const [folderCheckExpandedPaths, setFolderCheckExpandedPaths] = useState<string[]>([]);
  const [folderCheckFolderOptions, setFolderCheckFolderOptions] = useState<string[]>([]);
  const [folderCheckStartedAt, setFolderCheckStartedAt] = useState<number | null>(null);
  const [folderCheckElapsedSeconds, setFolderCheckElapsedSeconds] = useState(0);
  const [folderCheckScanJobId, setFolderCheckScanJobId] = useState<string | null>(null);
  const [folderCheckScanStatus, setFolderCheckScanStatus] = useState<FolderCheckScanStatusResponse | null>(null);
  const [folderCheckResolvingPath, setFolderCheckResolvingPath] = useState<string | null>(null);
  const [folderCheckResolvingSha, setFolderCheckResolvingSha] = useState<string | null>(null);
  const [folderCheckMonitorEnabled, setFolderCheckMonitorEnabled] = useState(true);
  const [folderCheckMonitorIntervalSeconds, setFolderCheckMonitorIntervalSeconds] = useState("120");
  const [folderCheckFilter, setFolderCheckFilter] = useState<
    "all" | "issues" | "duplicates" | "wrong-name" | "wrong-extension" | "exif" | "new" | "changed" | "heic"
  >("all");
  const [folderCheckSearch, setFolderCheckSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [networkDrives, setNetworkDrives] = useState<NetworkDriveItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanIntervalInput, setScanIntervalInput] = useState("120");
  const [scanIntervalDirty, setScanIntervalDirty] = useState(false);
  const [editingWorkflowId, setEditingWorkflowId] = useState<number | null>(null);
  const [workflowDialogOpen, setWorkflowDialogOpen] = useState(false);
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false);
  const [overwriteTarget, setOverwriteTarget] = useState<WorkflowItem | null>(null);
  const [workflowPathSelections, setWorkflowPathSelections] = useState<Record<WorkflowPathField, WorkflowPathSelection>>({
    source_path: { driveId: null, subfolder: "" },
    destination_path: { driveId: null, subfolder: "" },
    failed_path: { driveId: null, subfolder: "" },
  });
  const [workflowFolderDialogOpen, setWorkflowFolderDialogOpen] = useState(false);
  const [workflowFolderField, setWorkflowFolderField] = useState<WorkflowPathField | null>(null);
  const [workflowFolderDriveId, setWorkflowFolderDriveId] = useState<number | null>(null);
  const [workflowFolderOptions, setWorkflowFolderOptions] = useState<string[]>([]);
  const [workflowFolderLoading, setWorkflowFolderLoading] = useState(false);
  const [workflowFolderCache, setWorkflowFolderCache] = useState<Record<number, string[]>>({});
  const [expandedWorkflowFolderPaths, setExpandedWorkflowFolderPaths] = useState<string[]>([]);
  const [networkDialogOpen, setNetworkDialogOpen] = useState(false);
  const [editingDriveId, setEditingDriveId] = useState<number | null>(null);
  const [networkShareServer, setNetworkShareServer] = useState("");
  const [networkShareOptions, setNetworkShareOptions] = useState<string[]>([]);
  const [networkShareSelected, setNetworkShareSelected] = useState("");
  const [networkShareLoading, setNetworkShareLoading] = useState(false);
  const [networkDriveForm, setNetworkDriveForm] = useState<NetworkDrivePayload>({
    name: "",
    smb_path: "",
    mount_path: "",
    username: "",
    password: "",
    enabled: true,
  });
  const [workflowForm, setWorkflowForm] = useState<WorkflowPayload>({
    name: "",
    source_path: "",
    destination_path: "",
    failed_path: "",
    allowed_extensions: "",
    enabled: true,
  });
  const [driveOverwriteConfirmOpen, setDriveOverwriteConfirmOpen] = useState(false);
  const [driveOverwriteTarget, setDriveOverwriteTarget] = useState<NetworkDriveItem | null>(null);

  const workflowFolderTree = useMemo(() => buildWorkflowFolderTree(workflowFolderOptions), [workflowFolderOptions]);
  const historyByStatus = useMemo(() => {
    const grouped: Record<HistoryTab, HistoryItem[]> = {
      failed: [],
      duplicate: [],
      processed: [],
    };

    for (const item of history) {
      const status = item.status.toLowerCase();
      if (status === "failed" || status === "duplicate" || status === "processed") {
        grouped[status].push(item);
      }
    }

    return grouped;
  }, [history]);
  const folderCheckTree = useMemo(() => {
    const fileFolders = (folderCheckData?.files ?? []).map((item) => item.directory).filter(Boolean);
    const allFolders = [...folderCheckFolderOptions, ...fileFolders];
    return buildWorkflowFolderTree(allFolders);
  }, [folderCheckData, folderCheckFolderOptions]);
  const folderCheckVisibleFiles = useMemo(() => {
    const files = folderCheckData?.files ?? [];
    if (!folderCheckSelectedDirectory) {
      return files;
    }
    const prefix = `${folderCheckSelectedDirectory}/`;
    return files.filter((item) => item.directory === folderCheckSelectedDirectory || item.directory.startsWith(prefix));
  }, [folderCheckData, folderCheckSelectedDirectory]);
  const folderCheckFilteredFiles = useMemo(() => {
    const search = folderCheckSearch.trim().toLowerCase();
    return folderCheckVisibleFiles.filter((item) => {
      const matchFilter =
        folderCheckFilter === "all"
          ? true
          : folderCheckFilter === "issues"
            ? item.duplicate || item.wrong_name || item.wrong_extension || item.exif_invalid
            : folderCheckFilter === "duplicates"
              ? item.duplicate
              : folderCheckFilter === "wrong-name"
                ? item.wrong_name
                : folderCheckFilter === "wrong-extension"
                  ? item.wrong_extension
                  : folderCheckFilter === "exif"
                    ? item.exif_invalid
                    : folderCheckFilter === "new"
                      ? item.never_scanned
                      : folderCheckFilter === "changed"
                        ? item.changed_since_last_scan
                        : item.extension === ".heic";

      if (!matchFilter) {
        return false;
      }
      if (!search) {
        return true;
      }

      return (
        item.relative_path.toLowerCase().includes(search) ||
        item.filename.toLowerCase().includes(search) ||
        (item.sha256 ?? "").toLowerCase().includes(search)
      );
    });
  }, [folderCheckFilter, folderCheckSearch, folderCheckVisibleFiles]);
  const folderCheckDuplicateGroups = useMemo(() => {
    const groups = new Map<string, FolderCheckFileItem[]>();
    for (const item of folderCheckData?.files ?? []) {
      if (!item.sha256) {
        continue;
      }
      const arr = groups.get(item.sha256) ?? [];
      arr.push(item);
      groups.set(item.sha256, arr);
    }

    return [...groups.entries()]
      .filter(([, items]) => items.length > 1)
      .sort((left, right) => right[1].length - left[1].length)
      .map(([sha256, items]) => ({ sha256, items }));
  }, [folderCheckData]);
  const folderCheckSelectedExactDuplicates = useMemo(() => {
    if (!folderCheckSelectedFile?.sha256 || !folderCheckData) {
      return [] as FolderCheckFileItem[];
    }
    return folderCheckData.files.filter(
      (item) => item.sha256 === folderCheckSelectedFile.sha256 && item.relative_path !== folderCheckSelectedFile.relative_path
    );
  }, [folderCheckData, folderCheckSelectedFile]);
  const folderCheckHeicCount = useMemo(
    () => (folderCheckData?.files ?? []).filter((item) => item.extension === ".heic" || item.extension === ".heif").length,
    [folderCheckData]
  );
  const selectedFolderCheckDrive = useMemo(
    () => networkDrives.find((drive) => drive.folder_check_enabled) ?? null,
    [networkDrives]
  );

  const refreshDashboard = async () => {
    setRefreshing(true);
    try {
      const [statusData, historyData] = await Promise.all([fetchStatus(), fetchHistory()]);
      setStatus(statusData);
      setHistory(historyData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const refreshWorkflows = async () => {
    try {
      const items = await fetchWorkflows();
      setWorkflows(sortByName(items));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workflow load failed");
    }
  };

  const refreshNetworkDrives = async () => {
    try {
      const items = await fetchNetworkDrives();
      setNetworkDrives(sortByName(items));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network drive load failed");
    }
  };

  const runScan = async () => {
    try {
      const result = await triggerScan();
      await refreshDashboard();
      setNotice(`Scan complete: discovered ${result.discovered}, queued ${result.queued}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    }
  };

  const resetDashboardStats = async () => {
    try {
      const result = await resetStats();
      await refreshDashboard();
      setNotice(`Stats reset complete: removed ${result.deleted_rows} history rows.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset stats failed");
    }
  };

  const toggleScanSchedule = async () => {
    try {
      const schedule = status?.scan_schedule_enabled ? await stopScanSchedule() : await startScanSchedule();
      await refreshDashboard();
      setNotice(schedule.enabled ? "Scan schedule started." : "Scan schedule stopped.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan schedule toggle failed");
    }
  };

  const applyScanInterval = async () => {
    const parsed = Number.parseInt(scanIntervalInput, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setError("Scan interval must be a positive integer (seconds).");
      return;
    }
    try {
      const schedule = await updateScanInterval(parsed);
      await refreshDashboard();
      setScanIntervalInput(String(schedule.interval_seconds));
      setScanIntervalDirty(false);
      setNotice(`Scan interval updated to ${schedule.interval_seconds}s.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update scan interval failed");
    }
  };

  const refreshFolderCheckConfig = async () => {
    try {
      const config = await fetchFolderCheckConfig();
      setFolderCheckConfig(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Folder Check config load failed");
    }
  };

  const refreshFolderCheckFolders = async (driveId: number | null) => {
    if (driveId === null) {
      setFolderCheckFolderOptions([]);
      return;
    }
    try {
      const folders = await fetchNetworkDriveFolders(driveId);
      const sortedFolders = folders
        .map((folder) => folder.trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
      setFolderCheckFolderOptions(sortedFolders);
    } catch {
      setFolderCheckFolderOptions([]);
    }
  };

  const loadLatestFolderCheckResult = async () => {
    try {
      const latest = await fetchFolderCheckLatest();
      setFolderCheckData(latest);
      if (latest.files.length > 0) {
        setFolderCheckSelectedFile((prev) => prev ?? latest.files[0]);
      }
    } catch {
      // ignore missing initial result
    }
  };

  const executeFolderCheckScan = async () => {
    if (folderCheckLoading) {
      return;
    }
    if (!selectedFolderCheckDrive) {
      setError("Select one Folder Check drive in Admin > Network Drives.");
      return;
    }

    try {
      setFolderCheckStartedAt(Date.now());
      setFolderCheckElapsedSeconds(0);
      setFolderCheckLoading(true);
      setFolderCheckScanStatus(null);
      const started = await startFolderCheckScan();
      setFolderCheckScanJobId(started.job_id);
      setError(null);
      setNotice(started.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Folder Check scan failed");
      setFolderCheckLoading(false);
      setFolderCheckStartedAt(null);
    }
  };

  const ensureFolderCheckDriveConnected = async (): Promise<boolean> => {
    const drive = selectedFolderCheckDrive;
    if (!drive) {
      return false;
    }

    try {
      const checked = await checkNetworkDrive(drive.id);
      if (checked.connection_status === "connected") {
        return true;
      }
      const mounted = await mountNetworkDrive(drive.id);
      await refreshNetworkDrives();
      return mounted.connection_status === "connected";
    } catch {
      return false;
    }
  };

  const toggleFolderCheckTreePath = (path: string) => {
    setFolderCheckExpandedPaths((prev) =>
      prev.includes(path) ? prev.filter((item) => item !== path) : [...prev, path]
    );
  };

  const copyFolderCheckPath = async (relativePath: string) => {
    try {
      await navigator.clipboard.writeText(relativePath);
      setNotice("Path copied to clipboard.");
    } catch {
      setError("Copy failed");
    }
  };

  const openFolderCheckMetadataForFile = (item: FolderCheckFileItem) => {
    setFolderCheckSelectedDirectory(item.directory);
    setFolderCheckSelectedFile(item);
    if (!item.directory) {
      return;
    }
    const segments = item.directory.split("/").filter(Boolean);
    const paths: string[] = [];
    let cursor = "";
    for (const segment of segments) {
      cursor = cursor ? `${cursor}/${segment}` : segment;
      paths.push(cursor);
    }
    setFolderCheckExpandedPaths((prev) => {
      const merged = new Set(prev);
      for (const path of paths) {
        merged.add(path);
      }
      return [...merged];
    });
  };

  const keepFolderCheckDuplicateFile = async (sha256: string, keepRelativePath: string) => {
    try {
      const visiblePaths = folderCheckFilteredFiles.map((item) => item.relative_path);
      const currentSelectedPath = folderCheckSelectedFile?.relative_path ?? null;
      setFolderCheckResolvingPath(keepRelativePath);
      setFolderCheckResolvingSha(sha256);
      const response: FolderCheckResolveDuplicateResponse = await resolveFolderCheckDuplicateGroup({
        sha256,
        keep_relative_path: keepRelativePath,
      });
      setFolderCheckData(response.result);
      const filesByPath = new Map(response.result.files.map((item) => [item.relative_path, item]));
      const selectedStillExists = currentSelectedPath ? filesByPath.get(currentSelectedPath) ?? null : null;

      if (selectedStillExists) {
        setFolderCheckSelectedFile(selectedStillExists);
      } else if (currentSelectedPath) {
        const currentIndex = visiblePaths.indexOf(currentSelectedPath);
        let nextSelection: FolderCheckFileItem | null = null;

        if (currentIndex >= 0) {
          for (let index = currentIndex + 1; index < visiblePaths.length; index += 1) {
            const candidate = filesByPath.get(visiblePaths[index]);
            if (candidate) {
              nextSelection = candidate;
              break;
            }
          }
          if (!nextSelection) {
            for (let index = currentIndex - 1; index >= 0; index -= 1) {
              const candidate = filesByPath.get(visiblePaths[index]);
              if (candidate) {
                nextSelection = candidate;
                break;
              }
            }
          }
        }

        setFolderCheckSelectedFile(nextSelection ?? response.result.files[0] ?? null);
      } else {
        setFolderCheckSelectedFile(response.result.files[0] ?? null);
      }
      if (response.errors.length > 0) {
        setNotice(
          `Kept 1 file, deleted ${response.deleted_count}, skipped ${response.skipped_missing_count}. ${response.errors.length} errors.`
        );
      } else {
        setNotice(`Kept 1 file, deleted ${response.deleted_count}, skipped ${response.skipped_missing_count}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Duplicate resolve failed");
    } finally {
      setFolderCheckResolvingPath(null);
      setFolderCheckResolvingSha(null);
    }
  };

  const renderFolderCheckTree = (nodes: FolderCheckTreeNode[], depth = 0): ReactNode[] => {
    return nodes.flatMap((node) => {
      const hasChildren = node.children.length > 0;
      const isExpanded = folderCheckExpandedPaths.includes(node.path);
      const isActive = folderCheckSelectedDirectory === node.path;

      const row = (
        <Box key={node.path}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ pl: depth * 2 }}>
            <Button
              size="small"
              variant="text"
              onClick={() => toggleFolderCheckTreePath(node.path)}
              disabled={!hasChildren}
              sx={{ minWidth: 26, width: 26, px: 0, fontFamily: "monospace" }}
            >
              {hasChildren ? (isExpanded ? "-" : "+") : ""}
            </Button>
            <Button
              size="small"
              variant={isActive ? "contained" : "text"}
              onClick={() => setFolderCheckSelectedDirectory(node.path)}
              sx={{ justifyContent: "flex-start", textTransform: "none", flexGrow: 1 }}
            >
              {node.name}
            </Button>
          </Stack>
        </Box>
      );

      if (!hasChildren || !isExpanded) {
        return [row];
      }

      return [row, ...renderFolderCheckTree(node.children, depth + 1)];
    });
  };

  const updateWorkflowPathSelection = (field: WorkflowPathField, driveId: number | null, subfolder: string) => {
    const normalizedSubfolder = normalizeSubfolder(subfolder);
    const selectedDrive = networkDrives.find((item) => item.id === driveId) ?? null;
    setWorkflowPathSelections((prev) => ({
      ...prev,
      [field]: { driveId, subfolder: normalizedSubfolder },
    }));
    setWorkflowForm((prev) => ({
      ...prev,
      [field]: composeWorkflowPath(selectedDrive, normalizedSubfolder),
    }));
  };

  const resetWorkflowForm = () => {
    setEditingWorkflowId(null);
    setWorkflowDialogOpen(false);
    setWorkflowPathSelections({
      source_path: { driveId: null, subfolder: "" },
      destination_path: { driveId: null, subfolder: "" },
      failed_path: { driveId: null, subfolder: "" },
    });
    setWorkflowForm({
      name: "",
      source_path: "",
      destination_path: "",
      failed_path: "",
      allowed_extensions: "",
      enabled: true,
    });
  };

  const openCreateWorkflowDialog = () => {
    setEditingWorkflowId(null);
    setWorkflowPathSelections({
      source_path: { driveId: null, subfolder: "" },
      destination_path: { driveId: null, subfolder: "" },
      failed_path: { driveId: null, subfolder: "" },
    });
    setWorkflowForm({
      name: "",
      source_path: "",
      destination_path: "",
      failed_path: "",
      allowed_extensions: "",
      enabled: true,
    });
    setWorkflowDialogOpen(true);
  };

  const closeWorkflowDialog = () => {
    setWorkflowDialogOpen(false);
    setWorkflowFolderDialogOpen(false);
    setWorkflowFolderField(null);
    setWorkflowFolderDriveId(null);
    setWorkflowFolderOptions([]);
    setWorkflowFolderLoading(false);
    resetWorkflowForm();
  };

  const openWorkflowFolderDialog = async (field: WorkflowPathField) => {
    const driveId = workflowPathSelections[field].driveId;
    if (driveId === null) {
      setError(`Choose network first for ${workflowPathFieldLabels[field].toLowerCase()} path.`);
      return;
    }

    setWorkflowFolderField(field);
    setWorkflowFolderDriveId(driveId);
    setWorkflowFolderDialogOpen(true);
    setExpandedWorkflowFolderPaths([]);

    const cachedFolders = workflowFolderCache[driveId];
    if (cachedFolders !== undefined) {
      setWorkflowFolderOptions(cachedFolders);
      return;
    }

    setWorkflowFolderLoading(true);
    try {
      const folders: string[] = await fetchNetworkDriveFolders(driveId);
      const sortedFolders = folders.map((folder: string) => folder.trim()).filter(Boolean).sort((left: string, right: string) => left.localeCompare(right));
      setWorkflowFolderCache((prev) => ({ ...prev, [driveId]: sortedFolders }));
      setWorkflowFolderOptions(sortedFolders);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Folder load failed");
      setWorkflowFolderDialogOpen(false);
      setWorkflowFolderField(null);
      setWorkflowFolderDriveId(null);
    } finally {
      setWorkflowFolderLoading(false);
    }
  };

  const chooseWorkflowFolder = (subfolder: string) => {
    if (workflowFolderField === null || workflowFolderDriveId === null) {
      return;
    }
    updateWorkflowPathSelection(workflowFolderField, workflowFolderDriveId, subfolder);
    setWorkflowFolderDialogOpen(false);
    setWorkflowFolderField(null);
    setWorkflowFolderDriveId(null);
    setWorkflowFolderOptions([]);
    setExpandedWorkflowFolderPaths([]);
  };

  const handleWorkflowPathInputChange = (field: WorkflowPathField, value: string) => {
    setWorkflowForm((prev) => ({
      ...prev,
      [field]: value,
    }));

    setWorkflowPathSelections((prev) => ({
      ...prev,
      [field]: resolveWorkflowPathSelection(value, networkDrives),
    }));
  };

  const toggleWorkflowFolderPath = (path: string) => {
    setExpandedWorkflowFolderPaths((prev) =>
      prev.includes(path) ? prev.filter((item) => item !== path) : [...prev, path]
    );
  };

  const renderWorkflowFolderTree = (nodes: WorkflowFolderTreeNode[], depth = 0): ReactNode[] => {
    const activeSubfolder = workflowFolderField ? workflowPathSelections[workflowFolderField].subfolder : "";

    return nodes.flatMap((node) => {
      const hasChildren = node.children.length > 0;
      const isExpanded = expandedWorkflowFolderPaths.includes(node.path);
      const isSelected = activeSubfolder === node.path;

      const row = (
        <Box key={node.path}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ pl: depth * 2 }}>
            <Button
              size="small"
              variant="text"
              onClick={() => toggleWorkflowFolderPath(node.path)}
              disabled={!hasChildren}
              sx={{ minWidth: 26, width: 26, px: 0, fontFamily: "monospace" }}
            >
              {hasChildren ? (isExpanded ? "-" : "+") : ""}
            </Button>
            <Button
              size="small"
              variant={isSelected ? "contained" : "text"}
              onClick={() => chooseWorkflowFolder(node.path)}
              sx={{ justifyContent: "flex-start", textTransform: "none", flexGrow: 1 }}
            >
              {node.name}
            </Button>
          </Stack>
        </Box>
      );

      if (!hasChildren || !isExpanded) {
        return [row];
      }

      return [row, ...renderWorkflowFolderTree(node.children, depth + 1)];
    });
  };

  const renderWorkflowPathPicker = (field: WorkflowPathField) => {
    const selection = workflowPathSelections[field];
    const selectedDrive = networkDrives.find((item) => item.id === selection.driveId) ?? null;
    const driveLabel = selectedDrive?.name ?? "Select network";
    const currentPath = workflowForm[field] ?? "";

    return (
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <TextField
            select
            label={`${workflowPathFieldLabels[field]} Network`}
            value={selection.driveId ?? ""}
            onChange={(event) => {
              const nextDriveId = event.target.value === "" ? null : Number(event.target.value);
              updateWorkflowPathSelection(field, nextDriveId, "");
            }}
            sx={{ minWidth: 260 }}
          >
            <MenuItem value="">Select network</MenuItem>
            {networkDrives.map((drive) => (
              <MenuItem key={drive.id} value={drive.id}>
                {drive.name}
              </MenuItem>
            ))}
          </TextField>
          <Button variant="outlined" onClick={() => void openWorkflowFolderDialog(field)} disabled={selection.driveId === null}>
            Choose Subfolder
          </Button>
        </Stack>
        <TextField
          label={`${workflowPathFieldLabels[field]} Path`}
          value={currentPath}
          onChange={(event) => handleWorkflowPathInputChange(field, event.target.value)}
          fullWidth
        />
        <Typography variant="caption" color="text.secondary">
          {selection.driveId === null
            ? "No network selected."
            : selection.subfolder
              ? `${driveLabel} / ${selection.subfolder}`
              : `${driveLabel} / root`}
        </Typography>
      </Stack>
    );
  };

  const submitWorkflow = async () => {
    try {
      if (editingWorkflowId === null) {
        await createWorkflow(workflowForm);
        setNotice("Workflow created.");
      } else {
        const editedWorkflow = workflows.find((item) => item.id === editingWorkflowId) ?? null;
        const nameChanged = editedWorkflow !== null && editedWorkflow.name !== workflowForm.name;
        const overwriteTarget =
          nameChanged
            ? workflows.find((item) => item.id !== editingWorkflowId && item.name === workflowForm.name) ?? null
            : null;

        if (overwriteTarget !== null) {
          setOverwriteTarget(overwriteTarget);
          setOverwriteConfirmOpen(true);
          return;
        } else {
          await updateWorkflow(editingWorkflowId, workflowForm);
          setNotice("Workflow saved.");
        }
      }
      await refreshWorkflows();
      await refreshDashboard();
      resetWorkflowForm();
      setWorkflowDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workflow save failed");
    }
  };

  const confirmOverwriteWorkflow = async () => {
    if (editingWorkflowId === null || overwriteTarget === null) {
      setOverwriteConfirmOpen(false);
      setOverwriteTarget(null);
      return;
    }
    try {
      await deleteWorkflow(overwriteTarget.id);
      await updateWorkflow(editingWorkflowId, workflowForm);
      await refreshWorkflows();
      await refreshDashboard();
      setNotice(`Workflow '${overwriteTarget.name}' overwritten.`);
      setOverwriteConfirmOpen(false);
      setOverwriteTarget(null);
      resetWorkflowForm();
      setWorkflowDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workflow overwrite failed");
    }
  };

  const saveWorkflowAsNew = async () => {
    try {
      await createWorkflow(workflowForm);
      await refreshWorkflows();
      await refreshDashboard();
      setNotice("Workflow created (Save As).");
      resetWorkflowForm();
      setWorkflowDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workflow Save As failed");
    }
  };

  const startEditWorkflow = (item: WorkflowItem) => {
    setEditingWorkflowId(item.id);
    setWorkflowPathSelections({
      source_path: resolveWorkflowPathSelection(item.source_path, networkDrives),
      destination_path: resolveWorkflowPathSelection(item.destination_path, networkDrives),
      failed_path: resolveWorkflowPathSelection(item.failed_path, networkDrives),
    });
    setWorkflowForm({
      name: item.name,
      source_path: item.source_path,
      destination_path: item.destination_path,
      failed_path: item.failed_path,
      allowed_extensions: item.allowed_extensions ?? "",
      enabled: item.enabled,
    });
    setWorkflowDialogOpen(true);
  };

  const removeWorkflow = async (workflowId: number) => {
    try {
      await deleteWorkflow(workflowId);
      await refreshWorkflows();
      await refreshDashboard();
      if (editingWorkflowId === workflowId) {
        resetWorkflowForm();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workflow delete failed");
    }
  };

  const resetDriveForm = () => {
    setEditingDriveId(null);
    setNetworkShareServer("");
    setNetworkShareOptions([]);
    setNetworkShareSelected("");
    setNetworkShareLoading(false);
    setNetworkDriveForm({
      name: "",
      smb_path: "",
      mount_path: "",
      username: "",
      password: "",
      enabled: true,
    });
  };

  const closeDriveDialog = () => {
    setNetworkDialogOpen(false);
    resetDriveForm();
  };

  const openCreateDriveDialog = () => {
    resetDriveForm();
    setNetworkDialogOpen(true);
  };

  const openEditDriveDialog = (drive: NetworkDriveItem) => {
    setEditingDriveId(drive.id);
    setNetworkShareServer(extractServerFromSmbPath(drive.smb_path));
    setNetworkShareOptions([]);
    setNetworkShareSelected("");
    setNetworkShareLoading(false);
    setNetworkDriveForm({
      name: drive.name,
      smb_path: drive.smb_path,
      mount_path: drive.mount_path ?? "",
      username: drive.username,
      password: "",
      enabled: drive.enabled,
    });
    setNetworkDialogOpen(true);
  };

  const discoverShares = async () => {
    if (!networkShareServer.trim()) {
      setError("Enter server address first to discover shares.");
      return;
    }
    if (!networkDriveForm.username.trim()) {
      setError("Enter username first to discover shares.");
      return;
    }
    if (!networkDriveForm.password.trim()) {
      setError("Enter password first to discover shares.");
      return;
    }

    try {
      setNetworkShareLoading(true);
      const shares = await discoverNetworkDriveShares({
        server: networkShareServer.trim(),
        username: networkDriveForm.username.trim(),
        password: networkDriveForm.password,
      });
      setNetworkShareOptions(shares);
      setNetworkShareSelected(shares[0] ?? "");
      setNotice(shares.length > 0 ? `Found ${shares.length} shares.` : "No shares found.");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Share discovery failed");
    } finally {
      setNetworkShareLoading(false);
    }
  };

  const applySelectedShare = () => {
    if (!networkShareServer.trim() || !networkShareSelected) {
      return;
    }
    setNetworkDriveForm((prev) => ({
      ...prev,
      smb_path: `//${networkShareServer.trim()}/${networkShareSelected}`,
    }));
    setNotice(`SMB Path set to //${networkShareServer.trim()}/${networkShareSelected}`);
    setError(null);
  };

  const submitDrive = async () => {
    try {
      if (editingDriveId === null) {
        await createNetworkDrive(networkDriveForm);
        setError(null);
        setNotice("Network drive created.");
      } else {
        const editedDrive = networkDrives.find((item) => item.id === editingDriveId) ?? null;
        const nameChanged = editedDrive !== null && editedDrive.name !== networkDriveForm.name;
        const overwriteExisting =
          nameChanged
            ? networkDrives.find((item) => item.id !== editingDriveId && item.name === networkDriveForm.name) ?? null
            : null;

        if (overwriteExisting !== null) {
          setDriveOverwriteTarget(overwriteExisting);
          setDriveOverwriteConfirmOpen(true);
          return;
        }

        await updateNetworkDrive(editingDriveId, networkDriveForm);
        setError(null);
        setNotice("Network drive saved.");
      }
      await refreshNetworkDrives();
      closeDriveDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network drive save failed");
    }
  };

  const saveDriveAsNew = async () => {
    if (editingDriveId === null) {
      setError("Save As is only available while editing an existing network drive.");
      return;
    }

    const payload = {
      ...networkDriveForm,
      password: networkDriveForm.password.trim() ? networkDriveForm.password : undefined,
    };

    try {
      await cloneNetworkDrive(editingDriveId, payload);
      await refreshNetworkDrives();
      setError(null);
      setNotice("Network drive created (Save As).");
      closeDriveDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network drive Save As failed");
    }
  };

  const confirmOverwriteDrive = async () => {
    if (editingDriveId === null || driveOverwriteTarget === null) {
      setDriveOverwriteConfirmOpen(false);
      setDriveOverwriteTarget(null);
      return;
    }
    try {
      await deleteNetworkDrive(driveOverwriteTarget.id);
      await updateNetworkDrive(editingDriveId, networkDriveForm);
      await refreshNetworkDrives();
      setError(null);
      setNotice(`Network drive '${driveOverwriteTarget.name}' overwritten.`);
      setDriveOverwriteConfirmOpen(false);
      setDriveOverwriteTarget(null);
      closeDriveDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network drive overwrite failed");
    }
  };

  const removeDrive = async (driveId: number) => {
    try {
      await deleteNetworkDrive(driveId);
      await refreshNetworkDrives();
      setError(null);
      setNotice("Network drive deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network drive delete failed");
    }
  };

  const checkDrive = async (driveId: number) => {
    try {
      await checkNetworkDrive(driveId);
      await refreshNetworkDrives();
      setError(null);
      setNotice("Network drive check finished.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection check failed");
    }
  };

  const mountDrive = async (driveId: number) => {
    try {
      await mountNetworkDrive(driveId);
      await refreshNetworkDrives();
      setError(null);
      setNotice("Network drive mounted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mount failed");
    }
  };

  const toggleFolderCheckDrive = async (driveId: number, selected: boolean) => {
    try {
      await setNetworkDriveFolderCheck(driveId, selected);
      await refreshNetworkDrives();
      await refreshFolderCheckConfig();
      setError(null);
      setNotice(selected ? "Folder Check drive selected." : "Folder Check drive cleared.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Folder Check update failed");
    }
  };

  useEffect(() => {
    void Promise.all([
      refreshDashboard(),
      refreshWorkflows(),
      refreshNetworkDrives(),
      refreshFolderCheckConfig(),
      loadLatestFolderCheckResult(),
    ]);
    const timer = setInterval(() => {
      void refreshDashboard();
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!scanIntervalDirty && status) {
      setScanIntervalInput(String(status.scan_interval_seconds));
    }
  }, [scanIntervalDirty, status]);

  useEffect(() => {
    void refreshFolderCheckFolders(selectedFolderCheckDrive?.id ?? null);
  }, [selectedFolderCheckDrive?.id]);

  useEffect(() => {
    if (!folderCheckLoading || folderCheckStartedAt === null) {
      return;
    }

    const timer = setInterval(() => {
      const elapsed = Math.max(0, Math.floor((Date.now() - folderCheckStartedAt) / 1000));
      setFolderCheckElapsedSeconds(elapsed);
    }, 250);

    return () => clearInterval(timer);
  }, [folderCheckLoading, folderCheckStartedAt]);

  useEffect(() => {
    if (!folderCheckScanJobId) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const statusData = await fetchFolderCheckScanStatus();
        if (cancelled) {
          return;
        }
        setFolderCheckScanStatus(statusData);

        if (statusData.job_id !== folderCheckScanJobId) {
          return;
        }

        if (statusData.status === "completed") {
          const result = statusData.result ?? (await fetchFolderCheckLatest());
          if (cancelled) {
            return;
          }
          setFolderCheckData(result);
          setFolderCheckSelectedDirectory("");
          setFolderCheckExpandedPaths([]);
          setFolderCheckSelectedFile(result.files[0] ?? null);
          setFolderCheckLoading(false);
          setFolderCheckStartedAt(null);
          setFolderCheckScanJobId(null);
          setNotice(
            `Folder Check complete: ${result.summary.files_total} files in ${result.duration_ms}ms. New ${result.summary.never_scanned_total}, changed ${result.summary.changed_total}, duplicates ${result.summary.duplicates_total}.`
          );
        }

        if (statusData.status === "failed") {
          setFolderCheckLoading(false);
          setFolderCheckStartedAt(null);
          setFolderCheckScanJobId(null);
          setError(statusData.error_message ?? "Folder Check scan failed");
        }
      } catch {
        if (!cancelled) {
          setFolderCheckLoading(false);
          setFolderCheckStartedAt(null);
          setFolderCheckScanJobId(null);
          setError("Folder Check status polling failed");
        }
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [folderCheckScanJobId]);

  useEffect(() => {
    if (tab !== "folderCheck" || !folderCheckMonitorEnabled || folderCheckLoading || folderCheckScanJobId) {
      return;
    }

    const parsedInterval = Number.parseInt(folderCheckMonitorIntervalSeconds, 10);
    const intervalMs = Number.isFinite(parsedInterval) && parsedInterval > 4 ? parsedInterval * 1000 : 120000;

    const tick = async () => {
      if (!selectedFolderCheckDrive) {
        return;
      }
      const connected = await ensureFolderCheckDriveConnected();
      if (!connected) {
        return;
      }
      await executeFolderCheckScan();
    };

    if (folderCheckData === null) {
      void tick();
    }
    const timer = setInterval(() => {
      void tick();
    }, intervalMs);

    return () => clearInterval(timer);
  }, [
    tab,
    folderCheckMonitorEnabled,
    folderCheckMonitorIntervalSeconds,
    folderCheckLoading,
    folderCheckScanJobId,
    folderCheckData,
    selectedFolderCheckDrive,
  ]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box
        sx={{
          minHeight: "100vh",
          background:
            mode === "dark"
              ? "radial-gradient(circle at 20% 20%, rgba(255,106,61,0.18), transparent 45%), linear-gradient(145deg, #0d0d0d, #1e1e1e 50%, #111)"
              : "radial-gradient(circle at 15% 15%, rgba(219,75,31,0.2), transparent 40%), linear-gradient(135deg, #f8f1e9, #fffdf9 60%, #efe8de)",
          py: 4,
        }}
      >
        <Container maxWidth={tab === "folderCheck" ? false : "lg"}>
          <AppBar position="static" color="transparent" elevation={0} sx={{ mb: 3 }}>
            <Toolbar disableGutters sx={{ justifyContent: "space-between" }}>
              <Box>
                <Typography variant="h4">lxcPhotoConverter</Typography>
                <Typography variant="body2" color="text.secondary">
                  Automated media ingest for Proxmox LXC
                </Typography>
              </Box>
              <Stack direction="row" spacing={1}>
                {tab === "dashboard" && (
                  <>
                    <Button
                      variant="outlined"
                      color={status?.scan_schedule_enabled ? "warning" : "success"}
                      onClick={toggleScanSchedule}
                      disabled={refreshing}
                    >
                      {status?.scan_schedule_enabled ? "Stop Schedule" : "Start Schedule"}
                    </Button>
                    <Button
                      variant="outlined"
                      color="warning"
                      onClick={resetDashboardStats}
                      disabled={refreshing}
                    >
                      Reset Stats
                    </Button>
                    <Button
                      variant="contained"
                      startIcon={<AutorenewRoundedIcon />}
                      onClick={runScan}
                      disabled={refreshing}
                    >
                      Scan Now
                    </Button>
                  </>
                )}
                <IconButton onClick={toggleMode} color="primary">
                  {mode === "dark" ? <LightModeRoundedIcon /> : <DarkModeRoundedIcon />}
                </IconButton>
              </Stack>
            </Toolbar>
          </AppBar>

          <Paper sx={{ mb: 2, border: "1px solid", borderColor: "divider" }}>
            <Tabs
              value={tab}
              onChange={(_, value: "dashboard" | "admin" | "folderCheck") => setTab(value)}
              textColor="primary"
              indicatorColor="primary"
            >
              <Tab value="dashboard" label="Dashboard" />
              <Tab value="admin" label="Admin Workflows" />
              <Tab value="folderCheck" label="Folder Check" />
            </Tabs>
          </Paper>

          {loading ? (
            <Box sx={{ display: "grid", placeItems: "center", py: 10 }}>
              <CircularProgress />
            </Box>
          ) : tab === "admin" ? (
            <Stack spacing={3}>
              <Paper sx={{ p: 2, border: "1px solid", borderColor: "divider" }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                  <Typography variant="h6">Workflows</Typography>
                  <Button variant="contained" onClick={openCreateWorkflowDialog}>
                    Add Workflow
                  </Button>
                </Stack>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Name</TableCell>
                        <TableCell>Source</TableCell>
                        <TableCell>Destination</TableCell>
                        <TableCell>Failed</TableCell>
                        <TableCell>Filetypes</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell align="right">Actions</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {workflows.map((item) => (
                        <TableRow key={item.id} hover>
                          <TableCell>{item.name}</TableCell>
                          <TableCell sx={{ maxWidth: 160, wordBreak: "break-all" }}>{item.source_path}</TableCell>
                          <TableCell sx={{ maxWidth: 160, wordBreak: "break-all" }}>{item.destination_path}</TableCell>
                          <TableCell sx={{ maxWidth: 160, wordBreak: "break-all" }}>{item.failed_path}</TableCell>
                          <TableCell sx={{ maxWidth: 120, wordBreak: "break-all" }}>{item.allowed_extensions ?? "all"}</TableCell>
                          <TableCell>
                            <Chip size="small" color={item.enabled ? "success" : "default"} label={item.enabled ? "enabled" : "disabled"} />
                          </TableCell>
                          <TableCell align="right">
                            <Stack direction="row" spacing={1} justifyContent="flex-end">
                              <Button size="small" onClick={() => startEditWorkflow(item)}>
                                Edit
                              </Button>
                              <Button size="small" color="error" onClick={() => removeWorkflow(item.id)}>
                                Delete
                              </Button>
                            </Stack>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Paper>

              <Paper sx={{ p: 2, border: "1px solid", borderColor: "divider" }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                  <Typography variant="h6">Network Drives</Typography>
                  <Button variant="contained" onClick={openCreateDriveDialog}>Add Network Drive</Button>
                </Stack>
                <TableContainer sx={{ mb: 2 }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Name</TableCell>
                        <TableCell>SMB Path</TableCell>
                        <TableCell>Mount Path</TableCell>
                        <TableCell>User</TableCell>
                        <TableCell>Folder Check</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell align="right">Actions</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {networkDrives.map((drive) => (
                        <TableRow key={drive.id} hover>
                          <TableCell>{drive.name}</TableCell>
                          <TableCell sx={{ maxWidth: 180, wordBreak: "break-all" }}>{drive.smb_path}</TableCell>
                          <TableCell sx={{ maxWidth: 180, wordBreak: "break-all" }}>{drive.mount_path ?? "-"}</TableCell>
                          <TableCell>{drive.username}</TableCell>
                          <TableCell>
                            <Checkbox
                              checked={drive.folder_check_enabled}
                              onChange={(event) => void toggleFolderCheckDrive(drive.id, event.target.checked)}
                            />
                          </TableCell>
                          <TableCell>
                            <Stack spacing={0.5}>
                              <Chip
                                size="small"
                                label={drive.connection_status}
                                color={
                                  drive.connection_status === "connected"
                                    ? "success"
                                    : drive.connection_status === "partial"
                                      ? "warning"
                                      : drive.connection_status === "mount_unavailable" || drive.connection_status === "read_only"
                                        ? "warning"
                                        : drive.connection_status === "auth_failed" || drive.connection_status === "offline"
                                        ? "error"
                                        : "default"
                                }
                              />
                              {drive.last_error && (
                                <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 220, wordBreak: "break-word" }}>
                                  {drive.last_error}
                                </Typography>
                              )}
                            </Stack>
                          </TableCell>
                          <TableCell align="right">
                            <Stack direction="row" spacing={1} justifyContent="flex-end">
                              <Button size="small" onClick={() => mountDrive(drive.id)}>Mount</Button>
                              <Button size="small" onClick={() => checkDrive(drive.id)}>Check</Button>
                              <Button size="small" onClick={() => openEditDriveDialog(drive)}>Edit</Button>
                              <Button size="small" color="error" onClick={() => removeDrive(drive.id)}>Delete</Button>
                            </Stack>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Paper>

              <Dialog open={networkDialogOpen} onClose={closeDriveDialog} fullWidth maxWidth="sm">
                <DialogTitle>{editingDriveId === null ? "Add Network Drive" : `Edit Network Drive #${editingDriveId}`}</DialogTitle>
                <DialogContent>
                  <Stack spacing={2} sx={{ mt: 1 }}>
                    <TextField
                      label="Name"
                      value={networkDriveForm.name}
                      onChange={(event) => setNetworkDriveForm((prev) => ({ ...prev, name: event.target.value }))}
                      fullWidth
                    />
                    <TextField
                      label="Server (for share discovery)"
                      placeholder="10.13.20.1"
                      value={networkShareServer}
                      onChange={(event) => setNetworkShareServer(event.target.value)}
                      fullWidth
                    />
                    <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems="center">
                      <Button variant="outlined" onClick={discoverShares} disabled={networkShareLoading}>
                        {networkShareLoading ? "Discovering..." : "Discover Shares"}
                      </Button>
                      {networkShareLoading && <CircularProgress size={20} />}
                    </Stack>
                    {networkShareOptions.length > 0 && (
                      <>
                        <TextField
                          select
                          label="Available Shares"
                          value={networkShareSelected}
                          onChange={(event) => setNetworkShareSelected(event.target.value)}
                          fullWidth
                        >
                          {networkShareOptions.map((share) => (
                            <MenuItem key={share} value={share}>
                              {share}
                            </MenuItem>
                          ))}
                        </TextField>
                        <Button variant="outlined" onClick={applySelectedShare} disabled={!networkShareSelected}>
                          Use Selected Share
                        </Button>
                      </>
                    )}
                    <TextField
                      label="SMB Path"
                      placeholder="//server/share"
                      value={networkDriveForm.smb_path}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setNetworkDriveForm((prev) => ({ ...prev, smb_path: nextValue }));
                        const parsedServer = extractServerFromSmbPath(nextValue);
                        if (parsedServer) {
                          setNetworkShareServer(parsedServer);
                        }
                      }}
                      fullWidth
                    />
                    <TextField
                      label="Local Mount Path (optional)"
                      placeholder="/srv/import/share3"
                      value={networkDriveForm.mount_path}
                      onChange={(event) => setNetworkDriveForm((prev) => ({ ...prev, mount_path: event.target.value }))}
                      helperText="Directory is auto-created if service user has permission."
                      fullWidth
                    />
                    <TextField
                      label="Username"
                      value={networkDriveForm.username}
                      onChange={(event) => setNetworkDriveForm((prev) => ({ ...prev, username: event.target.value }))}
                      fullWidth
                    />
                    <TextField
                      label={editingDriveId === null ? "Password" : "Password (leave empty to keep)"}
                      type="password"
                      value={networkDriveForm.password}
                      onChange={(event) => setNetworkDriveForm((prev) => ({ ...prev, password: event.target.value }))}
                      fullWidth
                    />
                    <FormControlLabel
                      control={
                        <Switch
                          checked={networkDriveForm.enabled}
                          onChange={(event) =>
                            setNetworkDriveForm((prev) => ({ ...prev, enabled: event.target.checked }))
                          }
                        />
                      }
                      label="Enabled"
                    />
                  </Stack>
                </DialogContent>
                <DialogActions>
                  <Button onClick={closeDriveDialog}>Cancel</Button>
                  {editingDriveId !== null && (
                    <Button
                      variant="outlined"
                      onClick={saveDriveAsNew}
                      disabled={
                        !networkDriveForm.name.trim() ||
                        !networkDriveForm.smb_path.trim() ||
                        !networkDriveForm.username.trim()
                      }
                    >
                      Save As
                    </Button>
                  )}
                  <Button
                    variant="contained"
                    onClick={submitDrive}
                    disabled={
                      !networkDriveForm.name.trim() ||
                      !networkDriveForm.smb_path.trim() ||
                      !networkDriveForm.username.trim() ||
                      (editingDriveId === null && !networkDriveForm.password)
                    }
                  >
                    {editingDriveId === null ? "Create" : "Save"}
                  </Button>
                </DialogActions>
              </Dialog>

              <Dialog open={workflowDialogOpen} onClose={closeWorkflowDialog} fullWidth maxWidth="md">
                <DialogTitle>{editingWorkflowId === null ? "Add Workflow" : `Edit Workflow #${editingWorkflowId}`}</DialogTitle>
                <DialogContent>
                  <Stack spacing={2} sx={{ mt: 1 }}>
                    <TextField
                      label="Workflow Name"
                      value={workflowForm.name}
                      onChange={(event) => setWorkflowForm((prev) => ({ ...prev, name: event.target.value }))}
                      fullWidth
                    />
                    {renderWorkflowPathPicker("source_path")}
                    {renderWorkflowPathPicker("destination_path")}
                    {renderWorkflowPathPicker("failed_path")}
                    <TextField
                      label="Filetypes (comma-separated, optional)"
                      value={workflowForm.allowed_extensions}
                      onChange={(event) =>
                        setWorkflowForm((prev) => ({ ...prev, allowed_extensions: event.target.value }))
                      }
                      placeholder=".jpg,.jpeg,.heic,.mp4"
                      fullWidth
                    />
                    <Typography variant="body2" color="text.secondary">
                      Filename pattern is fixed: IMG_YYYYMMDD_HHMMSS.ext
                    </Typography>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={workflowForm.enabled}
                          onChange={(event) =>
                            setWorkflowForm((prev) => ({ ...prev, enabled: event.target.checked }))
                          }
                        />
                      }
                      label="Enabled"
                    />
                  </Stack>
                </DialogContent>
                <DialogActions>
                  <Button onClick={closeWorkflowDialog}>Cancel</Button>
                  {editingWorkflowId !== null && (
                    <Button variant="outlined" onClick={saveWorkflowAsNew} disabled={!workflowForm.name.trim()}>
                      Save As
                    </Button>
                  )}
                  <Button
                    variant="contained"
                    onClick={submitWorkflow}
                    disabled={
                      !workflowForm.name.trim() ||
                      !workflowForm.source_path.trim() ||
                      !workflowForm.destination_path.trim() ||
                      !workflowForm.failed_path.trim()
                    }
                  >
                    {editingWorkflowId === null ? "Create" : "Save"}
                  </Button>
                </DialogActions>
              </Dialog>

              <Dialog
                open={workflowFolderDialogOpen}
                onClose={() => {
                  setWorkflowFolderDialogOpen(false);
                  setWorkflowFolderField(null);
                  setWorkflowFolderDriveId(null);
                  setWorkflowFolderOptions([]);
                  setWorkflowFolderLoading(false);
                  setExpandedWorkflowFolderPaths([]);
                }}
                fullWidth
                maxWidth="sm"
              >
                <DialogTitle>Choose Subfolder</DialogTitle>
                <DialogContent>
                  <Stack spacing={2} sx={{ mt: 1 }}>
                    <Typography variant="body2" color="text.secondary">
                      {workflowFolderDriveId === null
                        ? "Select network first."
                        : `Pick folder for ${workflowPathFieldLabels[workflowFolderField ?? "source_path"]}`}
                    </Typography>
                    <Button variant="outlined" onClick={() => chooseWorkflowFolder("")}>Use drive root</Button>
                    {workflowFolderLoading ? (
                      <Box sx={{ display: "grid", placeItems: "center", py: 3 }}>
                        <CircularProgress size={24} />
                      </Box>
                    ) : (
                      <Box sx={{ maxHeight: 420, overflowY: "auto", border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1 }}>
                        {workflowFolderTree.length > 0 ? (
                          <Stack spacing={0.5}>{renderWorkflowFolderTree(workflowFolderTree)}</Stack>
                        ) : (
                          <Typography variant="body2" color="text.secondary">No subfolders found.</Typography>
                        )}
                      </Box>
                    )}
                  </Stack>
                </DialogContent>
                <DialogActions>
                  <Button
                    onClick={() => {
                      setWorkflowFolderDialogOpen(false);
                      setWorkflowFolderField(null);
                      setWorkflowFolderDriveId(null);
                      setWorkflowFolderOptions([]);
                      setWorkflowFolderLoading(false);
                      setExpandedWorkflowFolderPaths([]);
                    }}
                  >
                    Cancel
                  </Button>
                </DialogActions>
              </Dialog>

              <Dialog
                open={driveOverwriteConfirmOpen}
                onClose={() => {
                  setDriveOverwriteConfirmOpen(false);
                  setDriveOverwriteTarget(null);
                }}
                fullWidth
                maxWidth="xs"
              >
                <DialogTitle>Overwrite Network Drive?</DialogTitle>
                <DialogContent>
                  <Stack spacing={1} sx={{ mt: 0.5 }}>
                    <Typography variant="body2" color="text.secondary">
                      Network drive name already exists: {driveOverwriteTarget?.name ?? ""}. Save will overwrite that network drive.
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ wordBreak: "break-all" }}>
                      Existing SMB: {driveOverwriteTarget?.smb_path ?? "-"}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ wordBreak: "break-all" }}>
                      Existing Mount: {driveOverwriteTarget?.mount_path ?? "-"}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ wordBreak: "break-all" }}>
                      New SMB: {networkDriveForm.smb_path || "-"}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ wordBreak: "break-all" }}>
                      New Mount: {networkDriveForm.mount_path || "-"}
                    </Typography>
                  </Stack>
                </DialogContent>
                <DialogActions>
                  <Button
                    onClick={() => {
                      setDriveOverwriteConfirmOpen(false);
                      setDriveOverwriteTarget(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button color="warning" variant="contained" onClick={confirmOverwriteDrive}>
                    Overwrite
                  </Button>
                </DialogActions>
              </Dialog>

              <Dialog
                open={overwriteConfirmOpen}
                onClose={() => {
                  setOverwriteConfirmOpen(false);
                  setOverwriteTarget(null);
                }}
                fullWidth
                maxWidth="xs"
              >
                <DialogTitle>Overwrite Workflow?</DialogTitle>
                <DialogContent>
                  <Typography variant="body2" color="text.secondary">
                    Workflow name already exists: {overwriteTarget?.name ?? ""}. Save will overwrite that workflow.
                  </Typography>
                </DialogContent>
                <DialogActions>
                  <Button
                    onClick={() => {
                      setOverwriteConfirmOpen(false);
                      setOverwriteTarget(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button color="warning" variant="contained" onClick={confirmOverwriteWorkflow}>
                    Overwrite
                  </Button>
                </DialogActions>
              </Dialog>
            </Stack>
          ) : tab === "folderCheck" ? (
            <Stack spacing={3}>
              <Paper sx={{ p: 2, border: "1px solid", borderColor: "divider" }}>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2, wordBreak: "break-all" }}>
                  Path: {folderCheckConfig?.root_path ?? selectedFolderCheckDrive?.mount_path ?? "Select one drive in Admin > Network Drives"}
                </Typography>
                <Stack direction={{ xs: "column", md: "row" }} spacing={1} sx={{ mb: 1 }}>
                  <FormControlLabel
                    control={<Switch checked={folderCheckMonitorEnabled} onChange={(event) => setFolderCheckMonitorEnabled(event.target.checked)} />}
                    label="Auto monitor"
                  />
                  <TextField
                    size="small"
                    type="number"
                    label="Monitor interval (sec)"
                    value={folderCheckMonitorIntervalSeconds}
                    onChange={(event) => setFolderCheckMonitorIntervalSeconds(event.target.value)}
                    sx={{ maxWidth: 220 }}
                    inputProps={{ min: 5 }}
                  />
                </Stack>
                <Stack direction="row" spacing={1}>
                  <Button
                    variant="contained"
                    onClick={executeFolderCheckScan}
                    disabled={folderCheckLoading || !selectedFolderCheckDrive?.mount_path}
                  >
                    {folderCheckLoading ? "Scanning..." : "Run Scan"}
                  </Button>
                  <Button variant="outlined" onClick={() => void loadLatestFolderCheckResult()} disabled={folderCheckLoading}>
                    Load Latest
                  </Button>
                </Stack>
                {folderCheckLoading && (
                  <Box sx={{ mt: 1.5 }}>
                    <Typography variant="body2" color="text.secondary">
                      Running checks: recursive traversal, content hash, naming, extension and EXIF validation.
                    </Typography>
                    <LinearProgress
                      variant={folderCheckScanStatus ? "determinate" : "indeterminate"}
                      value={folderCheckScanStatus?.progress_percent ?? 0}
                      sx={{ mt: 1, mb: 0.5 }}
                    />
                    {folderCheckScanStatus && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                        Progress: {folderCheckScanStatus.progress_percent}% | folders {folderCheckScanStatus.scanned_directories} | files {folderCheckScanStatus.scanned_files}
                      </Typography>
                    )}
                    {folderCheckScanStatus?.current_item && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", wordBreak: "break-all" }}>
                        Current: {folderCheckScanStatus.current_item}
                      </Typography>
                    )}
                    <Typography variant="caption" color="text.secondary">
                      Elapsed: {folderCheckElapsedSeconds}s
                    </Typography>
                  </Box>
                )}
              </Paper>

              {folderCheckData && (
                <Paper sx={{ p: 2, border: "1px solid", borderColor: "divider" }}>
                  <Typography variant="body2" color="text.secondary">
                    Root: {folderCheckData.root_path}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    Scanned: {formatTimestamp(folderCheckData.scanned_at)} | Duration: {folderCheckData.duration_ms}ms
                  </Typography>
                  <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: "wrap" }}>
                    <Chip size="small" color="info" label={`Folders: ${folderCheckData.summary.directories_total}`} />
                    <Chip size="small" color="info" label={`Files: ${folderCheckData.summary.files_total}`} />
                    <Chip size="small" color="warning" label={`Duplicates: ${folderCheckData.summary.duplicates_total}`} />
                    <Chip size="small" color="error" label={`Wrong Name: ${folderCheckData.summary.wrong_name_total}`} />
                    <Chip size="small" color="warning" label={`HEIC ext: ${folderCheckHeicCount}`} />
                    <Chip size="small" color="error" label={`Wrong Ext: ${folderCheckData.summary.wrong_extension_total}`} />
                    <Chip size="small" color="warning" label={`EXIF Invalid: ${folderCheckData.summary.exif_invalid_total}`} />
                    <Chip size="small" color="success" label={`Never Scanned: ${folderCheckData.summary.never_scanned_total}`} />
                    <Chip size="small" color="secondary" label={`Changed: ${folderCheckData.summary.changed_total}`} />
                  </Stack>
                  <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ mt: 2 }}>
                    <Paper
                      sx={{
                        p: 1.5,
                        flex: 1,
                        minHeight: 420,
                        maxHeight: "70vh",
                        border: "1px solid",
                        borderColor: "divider",
                        overflowY: "scroll",
                        overflowX: "hidden",
                      }}
                    >
                      <Typography variant="subtitle2" sx={{ mb: 1 }}>
                        Folder Tree
                      </Typography>
                      <Button
                        variant={folderCheckSelectedDirectory === "" ? "contained" : "text"}
                        size="small"
                        onClick={() => setFolderCheckSelectedDirectory("")}
                        sx={{ mb: 1, textTransform: "none" }}
                      >
                        Root
                      </Button>
                      <Stack spacing={0.5}>{renderFolderCheckTree(folderCheckTree)}</Stack>
                    </Paper>

                    <Paper
                      sx={{
                        p: 1.5,
                        flex: 1.4,
                        minHeight: 420,
                        maxHeight: "70vh",
                        border: "1px solid",
                        borderColor: "divider",
                        overflowY: "scroll",
                        overflowX: "hidden",
                      }}
                    >
                      <Typography variant="subtitle2" sx={{ mb: 1 }}>
                        Files ({folderCheckFilteredFiles.length}/{folderCheckVisibleFiles.length})
                      </Typography>
                      <Stack direction={{ xs: "column", md: "row" }} spacing={1} sx={{ mb: 1 }}>
                        <TextField
                          size="small"
                          select
                          label="Filter"
                          value={folderCheckFilter}
                          onChange={(event) => setFolderCheckFilter(event.target.value as typeof folderCheckFilter)}
                          sx={{ minWidth: 200 }}
                        >
                          <MenuItem value="all">All</MenuItem>
                          <MenuItem value="issues">Issues</MenuItem>
                          <MenuItem value="duplicates">Duplicates</MenuItem>
                          <MenuItem value="wrong-name">Wrong name</MenuItem>
                          <MenuItem value="wrong-extension">Wrong extension</MenuItem>
                          <MenuItem value="exif">Invalid EXIF</MenuItem>
                          <MenuItem value="new">Never scanned</MenuItem>
                          <MenuItem value="changed">Changed</MenuItem>
                          <MenuItem value="heic">HEIC</MenuItem>
                        </TextField>
                        <TextField
                          size="small"
                          label="Search"
                          value={folderCheckSearch}
                          onChange={(event) => setFolderCheckSearch(event.target.value)}
                          sx={{ flexGrow: 1 }}
                        />
                      </Stack>
                      <TableContainer sx={{ maxHeight: "58vh" }}>
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell>Preview</TableCell>
                              <TableCell>File</TableCell>
                              <TableCell>Status</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {folderCheckFilteredFiles.map((item) => (
                              <TableRow
                                key={item.relative_path}
                                hover
                                selected={folderCheckSelectedFile?.relative_path === item.relative_path}
                                onClick={() => setFolderCheckSelectedFile(item)}
                                sx={{ cursor: "pointer" }}
                              >
                                <TableCell sx={{ width: 64 }}>
                                  <Box
                                    component="img"
                                    key={item.relative_path}
                                    src={folderCheckPreviewUrl(item.relative_path)}
                                    alt={item.filename}
                                    loading="lazy"
                                    sx={{ width: 48, height: 48, objectFit: "cover", borderRadius: 1, bgcolor: "action.hover" }}
                                  />
                                </TableCell>
                                <TableCell sx={{ maxWidth: 280, wordBreak: "break-all" }}>{item.filename}</TableCell>
                                <TableCell>
                                  <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap" }}>
                                    {item.duplicate && <Chip size="small" color="warning" label="dup" />}
                                    {item.wrong_name && <Chip size="small" color="error" label="name" />}
                                    {item.wrong_extension && <Chip size="small" color="error" label="ext" />}
                                    {item.exif_invalid && <Chip size="small" color="warning" label="exif" />}
                                    {item.never_scanned && <Chip size="small" color="success" label="new" />}
                                    {item.changed_since_last_scan && <Chip size="small" color="secondary" label="changed" />}
                                  </Stack>
                                </TableCell>
                              </TableRow>
                            ))}
                            {folderCheckFilteredFiles.length === 0 && (
                              <TableRow>
                                <TableCell colSpan={3} sx={{ color: "text.secondary" }}>
                                  No files for current filter.
                                </TableCell>
                              </TableRow>
                            )}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    </Paper>

                    <Paper sx={{ p: 1.5, flex: 1, minHeight: 420, border: "1px solid", borderColor: "divider", overflow: "auto" }}>
                      <Typography variant="subtitle2" sx={{ mb: 1 }}>
                        Details
                      </Typography>
                      {folderCheckSelectedFile ? (
                        <Stack spacing={1}>
                          <Box
                            component="img"
                            key={folderCheckSelectedFile.relative_path}
                            src={folderCheckPreviewUrl(folderCheckSelectedFile.relative_path)}
                            alt={folderCheckSelectedFile.filename}
                            sx={{ width: "100%", maxHeight: 220, objectFit: "contain", borderRadius: 1, bgcolor: "action.hover" }}
                          />
                          {folderCheckSelectedFile.duplicate && (
                            <Button
                              size="small"
                              variant="contained"
                              color="warning"
                              onClick={() =>
                                void keepFolderCheckDuplicateFile(
                                  folderCheckSelectedFile.sha256 ?? "",
                                  folderCheckSelectedFile.relative_path
                                )
                              }
                              disabled={folderCheckResolvingSha === folderCheckSelectedFile.sha256 || !folderCheckSelectedFile.sha256}
                            >
                              {folderCheckResolvingPath === folderCheckSelectedFile.relative_path ? "Working..." : "Keep This"}
                            </Button>
                          )}
                          <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                            {folderCheckSelectedFile.relative_path}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            Size: {folderCheckSelectedFile.size_bytes.toLocaleString()} bytes
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            Modified: {formatTimestamp(folderCheckSelectedFile.modified_at)}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            EXIF capture: {formatTimestamp(folderCheckSelectedFile.exif_capture_at)}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ wordBreak: "break-all" }}>
                            SHA-256: {folderCheckSelectedFile.sha256 ?? "-"}
                          </Typography>
                          <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap" }}>
                            {folderCheckSelectedFile.duplicate && <Chip size="small" color="warning" label="Exact duplicate" />}
                            {folderCheckSelectedFile.wrong_name && <Chip size="small" color="error" label="Wrong filename" />}
                            {folderCheckSelectedFile.wrong_extension && <Chip size="small" color="error" label="Wrong extension" />}
                            {folderCheckSelectedFile.exif_invalid && <Chip size="small" color="warning" label="Invalid EXIF" />}
                            {folderCheckSelectedFile.never_scanned && <Chip size="small" color="success" label="Never scanned" />}
                            {folderCheckSelectedFile.changed_since_last_scan && <Chip size="small" color="secondary" label="Changed since last scan" />}
                          </Stack>
                          {folderCheckSelectedFile.duplicate && (
                            <Box sx={{ mt: 1 }}>
                              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                                Exact duplicates ({folderCheckSelectedExactDuplicates.length})
                              </Typography>
                              <Stack spacing={1}>
                                {folderCheckSelectedExactDuplicates.map((item) => (
                                  <Stack
                                    key={item.relative_path}
                                    direction={{ xs: "column", md: "row" }}
                                    spacing={1}
                                    alignItems={{ md: "center" }}
                                    sx={{ p: 0.5, border: "1px solid", borderColor: "divider", borderRadius: 1 }}
                                  >
                                    <Box
                                      component="img"
                                      key={item.relative_path}
                                      src={folderCheckPreviewUrl(item.relative_path)}
                                      alt={item.filename}
                                      loading="lazy"
                                      sx={{ width: 52, height: 52, objectFit: "cover", borderRadius: 1, bgcolor: "action.hover" }}
                                    />
                                    <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                                      <Typography variant="caption" sx={{ display: "block" }}>
                                        {item.filename}
                                      </Typography>
                                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", wordBreak: "break-all" }}>
                                        {item.relative_path}
                                      </Typography>
                                    </Box>
                                    <Button
                                      size="small"
                                      variant="contained"
                                      color="warning"
                                      onClick={() =>
                                        void keepFolderCheckDuplicateFile(
                                          item.sha256 ?? "",
                                          item.relative_path
                                        )
                                      }
                                      disabled={folderCheckResolvingSha === item.sha256 || !item.sha256}
                                    >
                                      {folderCheckResolvingPath === item.relative_path ? "Working..." : "Keep This"}
                                    </Button>
                                  </Stack>
                                ))}
                                {folderCheckSelectedExactDuplicates.length === 0 && (
                                  <Typography variant="caption" color="text.secondary">
                                    No other duplicates found for selected file.
                                  </Typography>
                                )}
                              </Stack>
                            </Box>
                          )}
                        </Stack>
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          Select a file to inspect details.
                        </Typography>
                      )}
                    </Paper>
                  </Stack>

                  <Paper sx={{ p: 1.5, mt: 2, border: "1px solid", borderColor: "divider" }}>
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>
                      Duplicate Groups ({folderCheckDuplicateGroups.length})
                    </Typography>
                    <TableContainer>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>SHA-256</TableCell>
                            <TableCell align="right">Files</TableCell>
                            <TableCell>Preview + Actions</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {folderCheckDuplicateGroups.slice(0, 150).map((group) => (
                            <TableRow key={group.sha256} hover>
                              <TableCell sx={{ maxWidth: 240, wordBreak: "break-all" }}>{group.sha256}</TableCell>
                              <TableCell align="right">{group.items.length}</TableCell>
                              <TableCell sx={{ maxWidth: 720 }}>
                                <Stack spacing={1}>
                                  {group.items.slice(0, 20).map((item) => (
                                    <Stack
                                      key={item.relative_path}
                                      direction={{ xs: "column", md: "row" }}
                                      spacing={1}
                                      alignItems={{ md: "center" }}
                                      sx={{ p: 0.5, border: "1px solid", borderColor: "divider", borderRadius: 1 }}
                                    >
                                      <Box
                                        component="img"
                                        key={item.relative_path}
                                        src={folderCheckPreviewUrl(item.relative_path)}
                                        alt={item.filename}
                                        loading="lazy"
                                        sx={{ width: 54, height: 54, objectFit: "cover", borderRadius: 1, bgcolor: "action.hover" }}
                                      />
                                      <Typography variant="caption" sx={{ wordBreak: "break-all", flexGrow: 1 }}>
                                        {item.relative_path}
                                      </Typography>
                                      <Stack direction="row" spacing={0.5}>
                                        <Button size="small" variant="contained" color="warning" onClick={() => void keepFolderCheckDuplicateFile(group.sha256, item.relative_path)} disabled={folderCheckResolvingSha === group.sha256}>
                                          {folderCheckResolvingPath === item.relative_path ? "Working..." : "Keep This"}
                                        </Button>
                                        <Button size="small" variant="outlined" onClick={() => void copyFolderCheckPath(item.relative_path)}>
                                          Copy
                                        </Button>
                                        <Button size="small" variant="outlined" onClick={() => openFolderCheckMetadataForFile(item)}>
                                          Open Folder
                                        </Button>
                                      </Stack>
                                    </Stack>
                                  ))}
                                  {group.items.length > 20 && (
                                    <Typography variant="caption" color="text.secondary">
                                      +{group.items.length - 20} more paths
                                    </Typography>
                                  )}
                                </Stack>
                              </TableCell>
                            </TableRow>
                          ))}
                          {folderCheckDuplicateGroups.length === 0 && (
                            <TableRow>
                              <TableCell colSpan={3} sx={{ color: "text.secondary" }}>
                                No duplicates detected in latest scan.
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  </Paper>

                  {folderCheckData.scan_errors.length > 0 && (
                    <Box sx={{ mt: 2 }}>
                      <Typography variant="subtitle2" color="warning.main" sx={{ mb: 0.5 }}>
                        Scan warnings
                      </Typography>
                      <Stack spacing={0.5}>
                        {folderCheckData.scan_errors.map((issue) => (
                          <Typography key={issue} variant="caption" color="text.secondary" sx={{ wordBreak: "break-all" }}>
                            {issue}
                          </Typography>
                        ))}
                      </Stack>
                    </Box>
                  )}
                </Paper>
              )}
            </Stack>
          ) : (
            <Stack spacing={3}>
              <Paper sx={{ p: 2, border: "1px solid", borderColor: "divider" }}>
                <Typography variant="body2" color="text.secondary">
                  Next scheduled scan
                </Typography>
                <Typography variant="h6" sx={{ fontWeight: 700 }}>
                  {formatTimestamp(status?.next_scan_at ?? null)}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Schedule state: {status?.scan_schedule_enabled ? "running" : "stopped"}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Last scan: {formatTimestamp(status?.last_scan_at ?? null)} ({status?.last_scan_trigger ?? "-"})
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Last result: discovered {status?.last_scan_discovered ?? 0}, queued {status?.last_scan_queued ?? 0}
                </Typography>
                <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                  <TextField
                    label="Scan Interval (seconds)"
                    size="small"
                    value={scanIntervalInput}
                    onChange={(event) => {
                      setScanIntervalInput(event.target.value);
                      setScanIntervalDirty(true);
                    }}
                  />
                  <Button variant="contained" onClick={applyScanInterval} disabled={refreshing}>
                    Apply
                  </Button>
                </Stack>
              </Paper>

              <Paper sx={{ p: 2, border: "1px solid", borderColor: "divider" }}>
                <Typography variant="h6" sx={{ mb: 1 }}>
                  Workflow Input Folders
                </Typography>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Workflow</TableCell>
                        <TableCell>Source Folder</TableCell>
                        <TableCell align="right">Files</TableCell>
                        <TableCell align="right">Queued</TableCell>
                        <TableCell align="right">Processed</TableCell>
                        <TableCell align="right">Failed</TableCell>
                        <TableCell align="right">Duplicates</TableCell>
                        <TableCell>Status</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {(status?.workflow_sources ?? []).map((item) => (
                        <TableRow key={item.workflow_id} hover>
                          <TableCell>{item.workflow_name}</TableCell>
                          <TableCell sx={{ maxWidth: 260, wordBreak: "break-all" }}>{item.source_path}</TableCell>
                          <TableCell align="right">{item.files_total}</TableCell>
                          <TableCell align="right">{item.queued_files}</TableCell>
                          <TableCell align="right">{item.processed_files}</TableCell>
                          <TableCell align="right">{item.failed_files}</TableCell>
                          <TableCell align="right">{item.duplicate_files}</TableCell>
                          <TableCell>
                            <Chip size="small" color={item.enabled ? "success" : "default"} label={item.enabled ? "enabled" : "disabled"} />
                          </TableCell>
                        </TableRow>
                      ))}
                      {(status?.workflow_sources ?? []).length === 0 && (
                        <TableRow>
                          <TableCell colSpan={8} sx={{ color: "text.secondary" }}>
                            No workflows configured.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Paper>

              <Paper sx={{ p: 2, border: "1px solid", borderColor: "divider" }}>
                <Typography variant="h6" sx={{ mb: 1 }}>
                  Processing History
                </Typography>
                <Tabs
                  value={historyTab}
                  onChange={(_, value: HistoryTab) => setHistoryTab(value)}
                  textColor="primary"
                  indicatorColor="primary"
                  sx={{ mb: 1 }}
                >
                  <Tab value="failed" label={`Failed (${historyByStatus.failed.length})`} />
                  <Tab value="duplicate" label={`Duplicate (${historyByStatus.duplicate.length})`} />
                  <Tab value="processed" label={`Processed (${historyByStatus.processed.length})`} />
                </Tabs>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Time</TableCell>
                        <TableCell>Source</TableCell>
                        <TableCell>Destination</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell>Reason</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {historyByStatus[historyTab].map((row) => (
                        <TableRow key={row.id} hover>
                          <TableCell>{formatTimestamp(row.created_at)}</TableCell>
                          <TableCell sx={{ maxWidth: 220, wordBreak: "break-all" }}>{row.source_path}</TableCell>
                          <TableCell sx={{ maxWidth: 220, wordBreak: "break-all" }}>
                            {row.destination_path ?? "-"}
                          </TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              label={row.status}
                              color={
                                row.status === "processed"
                                  ? "success"
                                  : row.status === "duplicate"
                                    ? "warning"
                                    : row.status === "failed"
                                      ? "error"
                                      : "default"
                              }
                            />
                          </TableCell>
                          <TableCell sx={{ maxWidth: 320, wordBreak: "break-word" }}>
                            {row.error_message?.trim() || "-"}
                          </TableCell>
                        </TableRow>
                      ))}
                      {historyByStatus[historyTab].length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5} sx={{ color: "text.secondary" }}>
                            No {historyTab} entries.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Paper>
            </Stack>
          )}
        </Container>
      </Box>
      <Snackbar
        open={Boolean(error || notice)}
        autoHideDuration={6000}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        onClose={() => {
          setError(null);
          setNotice(null);
        }}
      >
        <Alert
          severity={error ? "error" : "success"}
          variant="filled"
          onClose={() => {
            setError(null);
            setNotice(null);
          }}
          sx={{ width: "100%" }}
        >
          {error ?? notice ?? ""}
        </Alert>
      </Snackbar>
    </ThemeProvider>
  );
};
