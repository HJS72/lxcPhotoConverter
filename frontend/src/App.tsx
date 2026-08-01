import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  AppBar,
  Box,
  Button,
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

export const App = () => {
  const { theme, mode, toggleMode } = useAppTheme();
  const [tab, setTab] = useState<"dashboard" | "admin">("dashboard");
  const [historyTab, setHistoryTab] = useState<HistoryTab>("failed");
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

  useEffect(() => {
    void Promise.all([refreshDashboard(), refreshWorkflows(), refreshNetworkDrives()]);
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
        <Container maxWidth="lg">
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
              onChange={(_, value: "dashboard" | "admin") => setTab(value)}
              textColor="primary"
              indicatorColor="primary"
            >
              <Tab value="dashboard" label="Dashboard" />
              <Tab value="admin" label="Admin Workflows" />
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
